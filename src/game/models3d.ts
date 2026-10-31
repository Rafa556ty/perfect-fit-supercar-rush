// Loading + normalising the car GLBs (browser only; import dynamically).
// Every car comes out facing -Z (forward), centred on X/Z, wheels on y = 0,
// scaled so its length matches the real car in metres.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import revueltoAsset from "@/assets/models/revuelto-race.glb.asset.json";
import m4Asset from "@/assets/models/bmw-m4-traffic.glb.asset.json";
import shelbyAsset from "@/assets/models/shelby-police-traffic.glb.asset.json";
import mustangAsset from "@/assets/models/mustang-gt-traffic.glb.asset.json";
import jeskoAsset from "@/assets/models/jesko-traffic.glb.asset.json";

export type ModelKey = "revuelto" | "m4" | "police" | "mustang" | "jesko";

type ModelSpec = { url: string; length: number; /** extra yaw (radians) when the file's nose isn't detected */ yaw: number };

export const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
  revuelto: { url: revueltoAsset.url, length: 4.95, yaw: 0 },
  m4: { url: m4Asset.url, length: 4.8, yaw: 0 },
  police: { url: shelbyAsset.url, length: 4.8, yaw: 0 },
  mustang: { url: mustangAsset.url, length: 4.8, yaw: 0 },
  jesko: { url: jeskoAsset.url, length: 4.6, yaw: 0 },
};

/** Revuelto body paint: the user wants it black, nothing else changed. */
export const REVUELTO_PAINT = 0x060607;

const cache = new Map<ModelKey, Promise<THREE.Group>>();

function makeLoader() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

export async function fetchGlb(url: string, onProgress?: (r: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    got += value.length;
    if (total) onProgress?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  onProgress?.(1);
  return out.buffer;
}

export async function parseGlb(buffer: ArrayBuffer): Promise<THREE.Group> {
  const gltf = await makeLoader().parseAsync(buffer, "");
  return gltf.scene;
}

/** Paint the Revuelto's body material black. */
export function paintRevuelto(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (mat?.name === "Body") {
        const std = mat as THREE.MeshStandardMaterial;
        std.color.setHex(REVUELTO_PAINT);
        std.metalness = 0.55;
        std.roughness = 0.22;
        std.map = null;
        std.needsUpdate = true;
      }
    }
  });
}

/** Rotate so the nose points at -Z, then centre and ground the model at real length. */
export function normalizeCar(scene: THREE.Group, spec: ModelSpec): THREE.Group {
  const pivot = new THREE.Group();
  pivot.add(scene);
  scene.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(scene);
  let size = box.getSize(new THREE.Vector3());
  // Long axis -> Z
  if (size.x > size.z) scene.rotation.y = Math.PI / 2;
  scene.rotation.y += spec.yaw;

  // Nose detection: headlights are toward the front, tail lights toward the back.
  scene.updateMatrixWorld(true);
  const head = new THREE.Vector3();
  const tail = new THREE.Vector3();
  let hw = 0;
  let tw = 0;
  const b = new THREE.Box3();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const label = `${(m.material as THREE.Material)?.name ?? ""} ${m.name}`.toLowerCase();
    const c = b.setFromObject(m).getCenter(new THREE.Vector3());
    if (/tail|rear_light|taillight/.test(label)) {
      tail.add(c);
      tw++;
    } else if (/headlight|daylight|head_light/.test(label)) {
      head.add(c);
      hw++;
    }
  });
  if (hw && tw && spec.yaw === 0) {
    head.divideScalar(hw);
    tail.divideScalar(tw);
    if (head.z > tail.z) scene.rotation.y += Math.PI; // nose was at +Z
  }

  scene.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(scene);
  size = box.getSize(new THREE.Vector3());
  const s = spec.length / Math.max(size.z, 1e-6);
  scene.scale.multiplyScalar(s);
  scene.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(scene);
  const c = box.getCenter(new THREE.Vector3());
  scene.position.x -= c.x;
  scene.position.z -= c.z;
  scene.position.y -= box.min.y;
  pivot.updateMatrixWorld(true);
  return pivot;
}

/** Static cars share one draw per compatible material, not one per tiny part. */
function batchCar(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    const geo = o.geometry.clone();
    // Meshopt may quantize the same attribute differently on separate parts.
    // Read normalized values before merging, so no car parts disappear.
    for (const [name, attribute] of Object.entries(geo.attributes)) {
      if (!(attribute instanceof THREE.BufferAttribute) && !(attribute instanceof THREE.InterleavedBufferAttribute)) continue;
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let i = 0; i < attribute.count; i++) {
        for (let component = 0; component < attribute.itemSize; component++) {
          values[i * attribute.itemSize + component] = attribute.getComponent(i, component);
        }
      }
      geo.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
    }
    // Decode quantized positions BEFORE baking transforms: writing a world
    // position back into Int16 attributes clips the body panels and wheels.
    geo.applyMatrix4(o.matrixWorld);
    const expanded = geo.toNonIndexed();
    geo.dispose();
    const attributes = Object.keys(expanded.attributes).sort().join(",");
    const key = `${o.material.uuid}:${attributes}`;
    let group = groups.get(key);
    if (!group) {
      group = { material: o.material, geometries: [] };
      groups.set(key, group);
    }
    group.geometries.push(expanded);
  });
  const result = new THREE.Group();
  for (const { material, geometries } of groups.values()) {
    const merged = mergeGeometries(geometries);
    if (merged) {
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = material.name;
      mesh.castShadow = true;
      result.add(mesh);
    }
    for (const geometry of geometries) geometry.dispose();
  }
  return result.children.length ? result : root;
}

/** Normalised, shared template for one car model (clone it per instance). */
export function loadCar(key: ModelKey): Promise<THREE.Group> {
  let p = cache.get(key);
  if (!p) {
    const spec = MODEL_SPECS[key];
    p = fetchGlb(spec.url)
      .then(parseGlb)
      .then((scene) => {
        if (key === "revuelto") paintRevuelto(scene);
        scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true;
            m.receiveShadow = false;
            m.frustumCulled = true;
          }
        });
        return batchCar(normalizeCar(scene, spec));
      });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
