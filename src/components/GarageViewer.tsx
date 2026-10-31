import { useEffect, useRef, useState } from "react";
import type * as THREE from "three";
import { X } from "lucide-react";
import carModelAsset from "@/assets/models/revuelto.glb.asset.json";
import { Button } from "@/components/ui/button";

export type GarageLabels = {
  title: string;
  hint: string;
  loading: string;
  error: string;
  close: string;
};

/**
 * The GLB is ~5.7 MB, so it is fetched once and kept in module scope: opening
 * the garage a second time paints the car instantly instead of re-downloading.
 */
let cachedGlb: ArrayBuffer | null = null;

async function fetchModel(onProgress: (ratio: number) => void): Promise<ArrayBuffer> {
  if (cachedGlb) return cachedGlb;

  const res = await fetch(carModelAsset.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();

  let buffer: ArrayBuffer;
  if (!reader) {
    buffer = await res.arrayBuffer();
  } else {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.length;
      if (total > 0) onProgress(Math.min(1, received / total));
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    buffer = merged.buffer;
  }

  onProgress(1);
  cachedGlb = buffer;
  return buffer;
}

/**
 * Turntable garage view of the real 3D Revuelto model.
 *
 * three.js and the loaders are imported lazily inside the effect: the racing
 * engine is a plain 2D canvas, so the ~600 KB 3D stack only ever downloads
 * when somebody actually opens the garage, and nothing browser-only is
 * evaluated during SSR.
 */
export function GarageViewer({
  labels,
  onClose,
}: {
  labels: GarageLabels;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let teardown: (() => void) | null = null;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      const THREE = await import("three");
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
      const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
      if (disposed) return;

      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      const canvas = renderer.domElement;
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.touchAction = "none";
      container.appendChild(canvas);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x08080b);
      scene.fog = new THREE.Fog(0x08080b, 14, 34);

      const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 120);

      // Studio-style reflections so the paint, glass and chrome read properly.
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environment = envTexture;
      scene.environmentIntensity = 0.6;

      const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 1;
      keyLight.shadow.camera.far = 40;
      keyLight.shadow.bias = -0.0006;
      scene.add(keyLight);
      scene.add(keyLight.target);

      const rimWarm = new THREE.DirectionalLight(0xffb347, 1.5);
      rimWarm.position.set(-6, 3, -5);
      scene.add(rimWarm);

      const rimCool = new THREE.DirectionalLight(0x7fb2ff, 0.8);
      rimCool.position.set(5, 2, -6);
      scene.add(rimCool);

      scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1208, 0.55));

      const loader = new GLTFLoader();
      const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
      loader.setMeshoptDecoder(MeshoptDecoder);
      const { paintRevuelto } = await import("@/game/models3d");
      const buffer = await fetchModel(setProgress);
      if (disposed) return;

      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.parse(buffer, "", resolve, reject);
      });
      if (disposed) return;

      const car = gltf.scene;
      paintRevuelto(car);
      // glTF is always Y up and this file's root node already carries the
      // exporter's axis conversion, so the model needs no re-orientation here.

      const pivot = new THREE.Group();
      pivot.add(car);
      scene.add(pivot);

      car.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });

      // Point the car's nose at +X by reading where the head and tail lamps sit,
      // so a swapped-in model still lands in a flattering three-quarter angle.
      const head = new THREE.Vector3();
      const tail = new THREE.Vector3();
      let headWeight = 0;
      let tailWeight = 0;
      pivot.updateMatrixWorld(true);
      const lampBox = new THREE.Box3();
      car.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const label = `${(mesh.material as { name?: string })?.name ?? ""} ${mesh.name}`.toLowerCase();
        const weight = mesh.geometry?.attributes?.["position"]?.count ?? 1;
        const center = lampBox.setFromObject(mesh).getCenter(new THREE.Vector3());
        if (label.includes("tail")) {
          tail.addScaledVector(center, weight);
          tailWeight += weight;
        } else if (label.includes("headlight") || label.includes("daylight")) {
          head.addScaledVector(center, weight);
          headWeight += weight;
        }
      });
      if (headWeight > 0 && tailWeight > 0) {
        head.divideScalar(headWeight);
        tail.divideScalar(tailWeight);
        const front = head.sub(tail);
        if (Math.hypot(front.x, front.z) > 0.05) {
          pivot.rotation.y = Math.atan2(front.z, front.x);
        }
      }

      // Rest the car on the floor and spin it around its own centre.
      pivot.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(pivot);
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      pivot.position.set(-center.x, -bounds.min.y, -center.z);
      pivot.updateMatrixWorld(true);

      const carLength = Math.max(size.x, size.z);
      const carHeight = Math.max(0.4, size.y);

      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(carLength * 2.2, 72),
        new THREE.MeshStandardMaterial({
          color: 0x0d0d12,
          roughness: 0.68,
          metalness: 0.22,
        }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = 0;
      ground.receiveShadow = true;
      scene.add(ground);

      keyLight.position.set(carLength * 0.9, carHeight * 6, carLength * 1.1);
      keyLight.target.position.set(0, carHeight * 0.4, 0);
      const shadowSpan = carLength * 0.9;
      keyLight.shadow.camera.left = -shadowSpan;
      keyLight.shadow.camera.right = shadowSpan;
      keyLight.shadow.camera.top = shadowSpan;
      keyLight.shadow.camera.bottom = -shadowSpan;
      keyLight.shadow.camera.updateProjectionMatrix();

      const target = new THREE.Vector3(0, carHeight * 0.45, 0);
      const viewDirection = new THREE.Vector3(0.68, 0.34, 0.65).normalize();

      /**
       * Distance that keeps the whole car inside the frame. A phone held
       * upright is tall and narrow, so the horizontal field of view is the one
       * that clips the car: it is derived from the FOV and the current aspect.
       */
      const frameDistance = () => {
        const halfVertical = Math.tan((camera.fov * Math.PI) / 360);
        const halfHorizontal = halfVertical * camera.aspect;
        return (
          Math.max(
            carLength / 2 / halfHorizontal,
            carHeight / 2 / halfVertical,
          ) * 1.12
        );
      };

      let baseDistance = frameDistance();
      camera.position.copy(target).addScaledVector(viewDirection, baseDistance);
      camera.lookAt(target);

      const controls = new OrbitControls(camera, canvas);
      controls.target.copy(target);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.enablePan = false;
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.85;
      controls.minDistance = baseDistance * 0.4;
      controls.maxDistance = baseDistance * 2.4;
      controls.minPolarAngle = Math.PI * 0.12;
      controls.maxPolarAngle = Math.PI * 0.495;
      controls.update();

      // Hand the turntable back a moment after the player lets go.
      let resumeTimer: ReturnType<typeof setTimeout> | undefined;
      const onStart = () => {
        if (resumeTimer) clearTimeout(resumeTimer);
        controls.autoRotate = false;
      };
      const onEnd = () => {
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => {
          controls.autoRotate = true;
        }, 2200);
      };
      controls.addEventListener("start", onStart);
      controls.addEventListener("end", onEnd);

      const resize = () => {
        const w = Math.max(1, container.clientWidth);
        const h = Math.max(1, container.clientHeight);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);

        // Keep the whole car framed through a rotation, but leave a zoom the
        // player already made alone.
        const next = frameDistance();
        const current = camera.position.distanceTo(controls.target);
        if (Math.abs(current - baseDistance) < 0.01) {
          const dir = camera.position.clone().sub(controls.target).normalize();
          camera.position.copy(controls.target).addScaledVector(dir, next);
        }
        baseDistance = next;
        controls.minDistance = baseDistance * 0.4;
        controls.maxDistance = baseDistance * 2.4;
      };
      const observer = new ResizeObserver(resize);
      observer.observe(container);

      const frame = () => {
        raf = requestAnimationFrame(frame);
        controls.update();
        renderer.render(scene, camera);
      };
      frame();

      setStatus("ready");

      teardown = () => {
        cancelAnimationFrame(raf);
        observer.disconnect();
        controls.removeEventListener("start", onStart);
        controls.removeEventListener("end", onEnd);
        if (resumeTimer) clearTimeout(resumeTimer);
        controls.dispose();
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry?.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) {
            if (!material) continue;
            for (const value of Object.values(
              material as unknown as Record<string, unknown>,
            )) {
              if ((value as THREE.Texture | null)?.isTexture) (value as THREE.Texture).dispose();
            }
            material.dispose();
          }
        });
        scene.environment = null;
        envTexture.dispose();
        pmrem.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        if (canvas.parentNode === container) container.removeChild(canvas);
      };
    })().catch((err: unknown) => {
      if (disposed) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    });

    return () => {
      disposed = true;
      if (teardown) teardown();
    };
  }, []);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-hud-border bg-scrim-top px-5 pb-3 pt-[max(env(safe-area-inset-top),18px)]">
        <div>
          <h2 className="font-display text-2xl leading-none tracking-[0.25em] text-primary">
            {labels.title}
          </h2>
          <p className="mt-1 font-display text-[11px] tracking-[0.3em] text-muted-foreground">
            LAMBORGHINI REVUELTO
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={labels.close}
          className="corner-cut border border-hud-border bg-hud p-2 text-foreground transition-colors hover:bg-secondary"
        >
          <X className="size-5" />
        </button>
      </div>

      <div ref={containerRef} className="relative min-h-0 flex-1 touch-none">
        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/95">
            <div className="h-1 w-40 overflow-hidden bg-secondary">
              <div
                className="h-full bg-primary transition-[width] duration-150"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="animate-pulse-soft font-display text-sm tracking-[0.25em] text-primary">
              {labels.loading} {Math.round(progress * 100)}%
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="font-display text-lg tracking-[0.2em] text-brake">{labels.error}</p>
            <p className="text-xs text-muted-foreground">{errorMsg}</p>
            <Button
              variant="outline"
              size="sm"
              className="border-hud-border bg-hud text-xs"
              onClick={onClose}
            >
              {labels.close}
            </Button>
          </div>
        )}
      </div>

      <p className="bg-scrim-bottom px-5 pb-[max(env(safe-area-inset-bottom),14px)] pt-2 text-center text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {labels.hint}
      </p>
    </div>
  );
}
