// Loading + normalising the car GLBs (browser only; import dynamically).
// Every car comes out facing -Z (forward), centred on X/Z, wheels on y = 0,
// scaled so its length matches the real car in metres.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { normalizeCar } from "./normalize-car";
export { normalizeCar } from "./normalize-car";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import revueltoAsset from "@/assets/models/revuelto-mobile.glb.asset.json";
import m4Asset from "@/assets/models/bmw-m4-traffic.glb.asset.json";
import mustangAsset from "@/assets/models/mustang-gt-traffic.glb.asset.json";

export type ModelKey = "revuelto" | "m4" | "mustang";

type ModelSpec = { url: string; length: number; /** extra yaw (radians) when the file's nose isn't detected */ yaw: number };

export const MODEL_SPECS: Record<ModelKey, ModelSpec> = {
  revuelto: { url: revueltoAsset.url, length: 4.95, yaw: 0 },
  m4: { url: m4Asset.url, length: 4.8, yaw: 0 },
  mustang: { url: mustangAsset.url, length: 4.8, yaw: 0 },
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

/** Static cars share one draw per compatible material, not one per tiny part. */
function batchCar(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const groups = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    const geo = o.geometry.clone();
    const material = o.material as THREE.MeshStandardMaterial;
    // Unused UV/tangent/color streams split otherwise identical materials.
    if (!material.normalMap) geo.deleteAttribute("tangent");
    if (!material.vertexColors) geo.deleteAttribute("color");
    if (!material.aoMap && !material.lightMap) geo.deleteAttribute("uv1");
    if (!material.map && !material.normalMap && !material.roughnessMap && !material.metalnessMap && !material.emissiveMap && !material.alphaMap) geo.deleteAttribute("uv");
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
    const mat = o.material as THREE.MeshStandardMaterial;
    const key = JSON.stringify([mat.type, mat.color?.getHex(), mat.emissive?.getHex(), mat.emissiveIntensity, mat.metalness, mat.roughness, mat.map?.uuid, mat.normalMap?.uuid, mat.roughnessMap?.uuid, mat.metalnessMap?.uuid, mat.alphaMap?.uuid, mat.aoMap?.uuid, mat.emissiveMap?.uuid, mat.transparent, mat.opacity, mat.side, mat.alphaTest, mat.depthWrite, mat.vertexColors, attributes]);
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
            const materials = Array.isArray(m.material) ? m.material : [m.material];
            for (const material of materials) {
              // Screen-space glass transmission redraws the entire world.
              // Reflective alpha glass retains windows without that extra pass.
              if (material instanceof THREE.MeshPhysicalMaterial && material.transmission > 0) {
                material.transmission = 0;
                material.transparent = true;
                material.opacity = 0.48;
                material.depthWrite = false;
              }
              material.forceSinglePass = true;
            }
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
