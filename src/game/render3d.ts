// three.js renderer for the racing game. Browser only: import dynamically.
// It never simulates anything; it only draws the RenderSnapshot the engine
// produces every frame. Sim coordinates are pixels; `ppm` converts to metres.
// World: player near the origin, forward = -Z, road scenery scrolls with pz.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { RenderCar, RenderSnapshot } from "./engine";
import type { CarType } from "./traffic";
import { loadCar, type ModelKey } from "./models3d";
import { AdaptiveResolution, phoneProfile } from "./quality";
import { BRIDGES, CYCLE, SIGN_GANTRIES, SPEED_RADARS, TUNNEL_FROM, TUNNEL_TO, cyc, inTunnel, lightsOn, nightAmount, rainAmount } from "./world";

const LANE_W = 3.6;
const ROAD_W = LANE_W * 3;
const SHOULDER = 1.6;
const DECK_W = ROAD_W + SHOULDER * 2; // asphalt incl. shoulders
const VIEW_AHEAD = 260;
const VIEW_BEHIND = 30;
const TILE_LEN = 24; // metres of road per texture tile
const STRIP_LEN = VIEW_AHEAD + VIEW_BEHIND;

const TYPE_MODEL: Record<CarType, ModelKey> = {
  m5: "m4",
  "mustang-blue": "mustang",
  "mustang-black": "mustang",
  jesko: "jesko",
  bus: "m4",
  suv: "m4",
  sedan: "mustang",
  hatch: "mustang",
  pickup: "m4",
};

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------- procedural textures ----------
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
    const context = c.getContext("2d");
    if (!context) throw new Error("Canvas context unavailable");
    draw(context);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, n: number, colors: string[], size: [number, number]) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[i % colors.length] ?? "#45474c";
    const s = size[0] + Math.random() * (size[1] - size[0]);
    g.fillRect(Math.random() * w, Math.random() * h, s, s);
  }
}

function roadTexture() {
  const W = 512;
  const H = 1024;
  return canvasTex(W, H, (g) => {
    g.fillStyle = "#3a3c40";
    g.fillRect(0, 0, W, H);
    noise(g, W, H, 26000, ["#45474c", "#2f3135", "#505257", "#36383c"], [1, 3]);
    // tyre-polished lane centres
    const px = W / DECK_W;
    for (let l = 0; l < 3; l++) {
      const cx = (SHOULDER + LANE_W * (l + 0.5)) * px;
      for (const off of [-0.85, 0.85]) {
        const grd = g.createLinearGradient(cx + off * px - 18, 0, cx + off * px + 18, 0);
        grd.addColorStop(0, "rgba(20,20,22,0)");
        grd.addColorStop(0.5, "rgba(20,20,22,0.22)");
        grd.addColorStop(1, "rgba(20,20,22,0)");
        g.fillStyle = grd;
        g.fillRect(cx + off * px - 18, 0, 36, H);
      }
    }
    // shoulder edge lines (solid)
    g.fillStyle = "#ece8dc";
    g.fillRect(SHOULDER * px - 6, 0, 8, H);
    g.fillRect((SHOULDER + ROAD_W) * px - 2, 0, 8, H);
    // dashed lane lines: 4 m dash, 8 m gap
    const mpy = H / TILE_LEN;
    for (const l of [1, 2]) {
      const x = (SHOULDER + LANE_W * l) * px - 3;
      for (let z = 0; z < TILE_LEN; z += 12) g.fillRect(x, z * mpy, 6, 4 * mpy);
    }
    // rumble strips on the shoulders
    g.fillStyle = "rgba(230,230,220,0.35)";
    for (let y = 0; y < H; y += 14) {
      g.fillRect(SHOULDER * px - 22, y, 12, 6);
      g.fillRect((SHOULDER + ROAD_W) * px + 10, y, 12, 6);
    }
  });
}

function grassTexture() {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = "#3f5f2a";
    g.fillRect(0, 0, 512, 512);
    noise(g, 512, 512, 30000, ["#4c6f32", "#36521f", "#5a7e3a", "#2f4a1b", "#6a7f3c"], [1, 4]);
  });
}

function concreteTexture() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = "#8d8a84";
    g.fillRect(0, 0, 256, 256);
    noise(g, 256, 256, 9000, ["#9a978f", "#7f7c76", "#a5a29a"], [1, 3]);
  });
}

function signTexture(lines: string[]) {
  return canvasTex(512, 192, (g) => {
    g.fillStyle = "#0f6b3a";
    g.fillRect(0, 0, 512, 192);
    g.strokeStyle = "#f2f2f2";
    g.lineWidth = 6;
    g.strokeRect(8, 8, 496, 176);
    g.fillStyle = "#f7f7f7";
    g.font = "bold 46px Arial, sans-serif";
    g.textBaseline = "middle";
    lines.forEach((l, i) => g.fillText(l, 30, 60 + i * 70));
  });
}

function radialTex(stops: [number, string][]) {
  const t = canvasTex(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [o, c] of stops) grd.addColorStop(o, c);
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------- exhaust flame shader ----------
const flameVert = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uSeed;
  void main() {
    vUv = uv;
    vec3 p = position;
    // turbulent wobble grows toward the tip
    float t = uv.y;
    p.x += sin(uTime * 41.0 + t * 9.0 + uSeed) * 0.02 * t;
    p.y += cos(uTime * 37.0 + t * 7.0 + uSeed * 2.0) * 0.02 * t;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const flameFrag = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uSeed;
  uniform float uCore;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y);
  }
  void main() {
    float t = vUv.y; // 0 = exhaust tip, 1 = flame end
    float ang = vUv.x * 6.2831;
    float turb = n(vec2(ang * 1.5 + uSeed, t * 6.0 - uTime * 28.0)) * 0.6
               + n(vec2(ang * 3.0, t * 14.0 - uTime * 45.0)) * 0.4;
    float body = pow(1.0 - t, 1.3) * (0.55 + turb * 0.9);
    body *= smoothstep(0.0, 0.06, t);
    vec3 blue = vec3(0.45, 0.65, 1.0);
    vec3 white = vec3(1.0, 0.95, 0.85);
    vec3 orange = vec3(1.0, 0.45, 0.08);
    vec3 red = vec3(0.7, 0.08, 0.02);
    vec3 col = mix(blue, white, smoothstep(0.02, 0.15, t));
    col = mix(col, orange, smoothstep(0.15, 0.45, t));
    col = mix(col, red, smoothstep(0.55, 0.95, t));
    col = mix(col, mix(blue, white, t * 3.0), uCore);
    float a = clamp(body * uIntensity, 0.0, 1.0);
    gl_FragColor = vec4(col * (1.6 + uCore), a);
  }
`;

type Flame = { group: THREE.Group; outer: THREE.ShaderMaterial; core: THREE.ShaderMaterial; glow: THREE.Sprite; light: THREE.PointLight };

type CarRig = {
  root: THREE.Group;
  tail: THREE.Mesh[];
  blinkL: THREE.Mesh;
  blinkR: THREE.Mesh;
  model: ModelKey;
};

export class Scene3D {
  private low = phoneProfile({ userAgent: navigator.userAgent, memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory, cores: navigator.hardwareConcurrency || 4, touch: navigator.maxTouchPoints > 0 });
  private quality = new AdaptiveResolution();
  private width = 1;
  private height = 1;
  private lastFrame = 0;
  private baseDpr = 1;
  private rainColor = new THREE.Color(0x707a86);
  private seen = new Set<RenderCar>();
  private matrix = new THREE.Matrix4();
  private quaternion = new THREE.Quaternion();
  private scaleVector = new THREE.Vector3();
  private positionVector = new THREE.Vector3();
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.Fog;
  private sky = new THREE.Color();
  private dayColor = new THREE.Color(0xa9cbe8);
  private duskColor = new THREE.Color(0x3a3550);
  private nightColor = new THREE.Color(0x05070d);
  private tunnelColor = new THREE.Color(0x14120f);

  private roadTex: THREE.CanvasTexture;
  private grassTex: THREE.CanvasTexture;
  private roadMat: THREE.MeshStandardMaterial;

  private posts!: THREE.InstancedMesh;
  private trunks!: THREE.InstancedMesh;
  private crowns!: THREE.InstancedMesh;
  private lampPoles!: THREE.InstancedMesh;
  private lampHeads!: THREE.InstancedMesh;
  private lampPools!: THREE.InstancedMesh;
  private lampHeadMat!: THREE.MeshStandardMaterial;
  private lampPoolMat!: THREE.MeshBasicMaterial;

  private tunnel!: THREE.Group;
  private tunnelLightMat!: THREE.MeshStandardMaterial;
  private tunnelLamp: THREE.PointLight;
  private bridges: THREE.Group[] = [];
  private gantries: THREE.Group[] = [];
  private radars: THREE.Group[] = [];

  private player: THREE.Group | null = null;
  private playerTail: THREE.MeshStandardMaterial[] = [];
  private playerHead: THREE.MeshStandardMaterial[] = [];
  private headL: THREE.SpotLight;
  private headR: THREE.SpotLight;
  private flames: Flame[] = [];
  private flameAmt = 0;
  private flameLen = 0;
  private popT = 0;

  private police: THREE.Group | null = null;
  private policeRed: THREE.PointLight;
  private policeBlue: THREE.PointLight;
  private policeBarR!: THREE.MeshBasicMaterial;
  private policeBarB!: THREE.MeshBasicMaterial;

  private templates = new Map<ModelKey, THREE.Group>();
  private pool = new Map<ModelKey, CarRig[]>();
  private active = new Map<RenderCar, CarRig>();
  private tailMatOff = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a0a, emissiveIntensity: 0.4 });
  private blinkMat = new THREE.MeshStandardMaterial({ color: 0x5a3300, emissive: 0xffa000, emissiveIntensity: 0 });

  private sprites: THREE.Sprite[] = [];
  private smokeTex: THREE.Texture;
  private sparkTex: THREE.Texture;
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;

  private time = 0;
  private camX = 0;
  private ready = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private overlay: HTMLElement | null,
    private onReady?: () => void,
  ) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.low ? 1 : 1.5);
    this.baseDpr = dpr;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.low && dpr < 1.5, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(dpr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !this.low;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.fog = new THREE.Fog(0xa9cbe8, 60, VIEW_AHEAD - 10);
    this.scene.fog = this.fog;
    this.scene.background = this.sky;

    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x3b4a2a, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -14;
    sc.right = 14;
    sc.top = 22;
    sc.bottom = -22;
    sc.near = 1;
    sc.far = 80;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.tunnelLamp = new THREE.PointLight(0xffc98a, 0, 26, 1.6);
    this.scene.add(this.tunnelLamp);

    this.headL = this.makeHeadlight();
    this.headR = this.makeHeadlight();
    this.policeRed = new THREE.PointLight(0xff1020, 0, 14, 1.5);
    this.policeBlue = new THREE.PointLight(0x2050ff, 0, 14, 1.5);

    this.roadTex = roadTexture();
    this.roadTex.repeat.set(1, STRIP_LEN / TILE_LEN);
    this.grassTex = grassTexture();
    this.grassTex.repeat.set(10, STRIP_LEN / 8);
    this.roadMat = new THREE.MeshStandardMaterial({ map: this.roadTex, roughness: 0.88, metalness: 0.02 });

    this.smokeTex = radialTex([
      [0, "rgba(255,255,255,0.9)"],
      [0.5, "rgba(255,255,255,0.35)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    this.sparkTex = radialTex([
      [0, "rgba(255,255,255,1)"],
      [0.25, "rgba(255,200,90,0.9)"],
      [1, "rgba(255,90,0,0)"],
    ]);

    this.buildWorld();

    // Rain: streaks in a box around the camera
    const N = this.low ? 180 : 500;
    this.rainPos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) this.resetDrop(i, true);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xcfe2ff, transparent: true, opacity: 0, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);

    for (let i = 0; i < (this.low ? 32 : 96); i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false }));
      s.visible = false;
      this.sprites.push(s);
      this.scene.add(s);
    }

    void this.loadModels();
  }

  private makeHeadlight() {
    const s = new THREE.SpotLight(0xfff4e0, 0, 90, 0.42, 0.55, 1.2);
    if (!this.low) this.scene.add(s, s.target);
    return s;
  }

  private resetDrop(i: number, anywhere: boolean) {
    const x = (Math.random() - 0.5) * 40;
    const z = -Math.random() * 60 + 8;
    const y = anywhere ? Math.random() * 18 : 18;
    const o = i * 6;
    this.rainPos.set([x, y, z, x - 0.05, y - 0.9, z + 0.25], o);
  }

  // ---------- static + scrolling world ----------
  private buildWorld() {
    const mid = -(VIEW_AHEAD - VIEW_BEHIND) / 2;

    const road = new THREE.Mesh(new THREE.PlaneGeometry(DECK_W, STRIP_LEN), this.roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.z = mid;
    road.receiveShadow = true;
    this.scene.add(road);

    const gravelMat = new THREE.MeshStandardMaterial({ color: 0x77706a, roughness: 1 });
    const grassMat = new THREE.MeshStandardMaterial({ map: this.grassTex, roughness: 1 });
    for (const side of [-1, 1]) {
      const gravel = new THREE.Mesh(new THREE.PlaneGeometry(2.2, STRIP_LEN), gravelMat);
      gravel.rotation.x = -Math.PI / 2;
      gravel.position.set(side * (DECK_W / 2 + 1.1), -0.02, mid);
      gravel.receiveShadow = true;
      const grass = new THREE.Mesh(new THREE.PlaneGeometry(160, STRIP_LEN), grassMat);
      grass.rotation.x = -Math.PI / 2;
      grass.position.set(side * (DECK_W / 2 + 2.2 + 80), -0.05, mid);
      grass.receiveShadow = true;
      this.scene.add(gravel, grass);

      // W-beam guardrail (continuous)
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.32, STRIP_LEN),
        new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.85, roughness: 0.35 }),
      );
      rail.position.set(side * (DECK_W / 2 + 0.45), 0.62, mid);
      rail.castShadow = true;
      this.scene.add(rail);
    }

    const postGeo = new THREE.BoxGeometry(0.12, 0.75, 0.12);
    postGeo.translate(0, 0.37, 0);
    this.posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x6a6e74, metalness: 0.6, roughness: 0.5 }), 160);
    this.scene.add(this.posts);

    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.4, 6);
    trunkGeo.translate(0, 1.2, 0);
    const crownGeo = new THREE.IcosahedronGeometry(2.2, 1);
    crownGeo.translate(0, 4.2, 0);
    this.trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }), 140);
    this.crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x2f5320, roughness: 0.95, flatShading: true }), 140);
    this.crowns.castShadow = true;
    this.scene.add(this.trunks, this.crowns);

    const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 9, 8);
    poleGeo.translate(0, 4.5, 0);
    this.lampPoles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.7, roughness: 0.4 }), 24);
    const headGeo = new THREE.BoxGeometry(1.8, 0.18, 0.5);
    headGeo.translate(0, 9, 0);
    this.lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffd9a0, emissiveIntensity: 0 });
    this.lampHeads = new THREE.InstancedMesh(headGeo, this.lampHeadMat, 24);
    const poolGeo = new THREE.CircleGeometry(5.5, 24);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate(0, 0.02, 0);
    this.lampPoolMat = new THREE.MeshBasicMaterial({
      map: radialTex([
        [0, "rgba(255,210,150,0.8)"],
        [1, "rgba(255,210,150,0)"],
      ]),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.lampPools = new THREE.InstancedMesh(poolGeo, this.lampPoolMat, 24);
    this.scene.add(this.lampPoles, this.lampHeads, this.lampPools);

    this.buildTunnel();

    const concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.9 });
    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const deck = new THREE.Mesh(new THREE.BoxGeometry(DECK_W + 30, 1.2, 12), concrete);
      deck.position.y = 6.6;
      deck.castShadow = true;
      g.add(deck);
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(DECK_W + 30, 0.9, 0.3), concrete);
      barrier.position.set(0, 7.6, 5.8);
      g.add(barrier, barrier.clone().translateZ(-11.6));
      for (const x of [-(DECK_W / 2 + 2.4), 0, DECK_W / 2 + 2.4]) {
        const pier = new THREE.Mesh(new THREE.BoxGeometry(x === 0 ? 0.6 : 1.2, 6.2, 3), concrete);
        pier.position.set(x, 3.0, 0);
        pier.castShadow = true;
        if (x !== 0) g.add(pier);
      }
      g.visible = false;
      this.bridges.push(g);
      this.scene.add(g);
    }

    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 });
    const signs = [
      ["São Paulo  42 km", "Campinas  96 km"],
      ["Saída 23  →", "Interlagos"],
      ["Rodovia dos", "Bandeirantes"],
    ];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 7.2, 8), steel);
        leg.position.set(s * (DECK_W / 2 + 0.9), 3.6, 0);
        g.add(leg);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(DECK_W + 2, 0.5, 0.5), steel);
      beam.position.y = 6.9;
      g.add(beam);
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(6.5, 2.4, 0.15),
        new THREE.MeshStandardMaterial({ map: signTexture(signs[i] ?? []), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0, emissiveMap: null }),
      );
      sign.position.set(-1.8, 6.2, 0.35);
      g.add(sign);
      g.traverse((o) => (o.castShadow = true));
      g.visible = false;
      this.gantries.push(g);
      this.scene.add(g);
    }

    for (let i = 0; i < 2; i++) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5.2, 8), steel);
      pole.position.y = 2.6;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.7), new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 }));
      box.position.set(-0.3, 5.2, 0);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.15, 16), new THREE.MeshBasicMaterial({ color: 0x111111 }));
      lens.position.set(-0.3, 5.2, -0.36);
      lens.rotation.y = Math.PI;
      g.add(pole, box, lens);
      g.position.x = DECK_W / 2 + 1.6;
      g.visible = false;
      this.radars.push(g);
      this.scene.add(g);
    }
  }

  private buildTunnel() {
    const len = TUNNEL_TO - TUNNEL_FROM;
    const g = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.75 });
    const tileMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.35 });
    const ceilMat = new THREE.MeshStandardMaterial({ color: 0x2b2a28, roughness: 0.9, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.5, len), wallMat);
      wall.position.set(s * (DECK_W / 2 + 0.6), 3.25, -len / 2);
      const tiles = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, len), tileMat);
      tiles.position.set(s * (DECK_W / 2 + 0.3), 1.4, -len / 2);
      g.add(wall, tiles);
    }
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(DECK_W + 1.7, 0.4, len), ceilMat);
    ceil.position.set(0, 6.6, -len / 2);
    g.add(ceil);
    // portal facade
    const portal = new THREE.Mesh(new THREE.BoxGeometry(DECK_W + 18, 9, 1.2), new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.9 }));
    portal.position.set(0, 10.4, 0.6);
    const sideL = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 1.2), portal.material);
    sideL.position.set(-(DECK_W / 2 + 4.9), 3, 0.6);
    const sideR = sideL.clone();
    sideR.position.x *= -1;
    const exit = portal.clone();
    exit.position.z = -len - 0.6;
    const exitL = sideL.clone();
    exitL.position.z = -len - 0.6;
    const exitR = sideR.clone();
    exitR.position.z = -len - 0.6;
    g.add(portal, sideL, sideR, exit, exitL, exitR);

    // fluorescent strip lights every 8 m, two rows
    this.tunnelLightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd7a0, emissiveIntensity: 2.5 });
    const n = Math.floor(len / 8);
    const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.25, 0.08, 3.2), this.tunnelLightMat, n * 2);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      m.makeTranslation(-2.2, 6.36, -i * 8 - 4);
      strips.setMatrixAt(i * 2, m);
      m.makeTranslation(2.2, 6.36, -i * 8 - 4);
      strips.setMatrixAt(i * 2 + 1, m);
    }
    g.add(strips);
    g.visible = false;
    this.tunnel = g;
    this.scene.add(g);
  }

  // ---------- models ----------
  private async loadModels() {
    const player = await loadCar("revuelto").catch((e) => {
      console.error("Revuelto model failed", e);
      return null;
    });
    if (player) this.setupPlayer(player.clone(true));
    const keys: ModelKey[] = ["m4", "mustang", "jesko", "police"];
    await Promise.all(
      keys.map((k) =>
        loadCar(k)
          .then((t) => {
            this.templates.set(k, t);
            if (k === "police") this.setupPolice(t.clone(true));
          })
          .catch((e) => console.error(`model ${k} failed`, e)),
      ),
    );
    this.canvas.dataset["modelsReady"] = "true";
  }

  private setupPlayer(car: THREE.Group) {
    const exhausts: THREE.Vector3[] = [];
    const box = new THREE.Box3();
    car.updateMatrixWorld(true);
    car.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mat, i) => {
        const name = mat.name.toLowerCase();
        if (name.startsWith("tail") || name === "taillight_rear") {
          const c = (mat as THREE.MeshStandardMaterial).clone();
          c.emissive = new THREE.Color(0xff1a08);
          c.emissiveIntensity = 0.6;
          if (Array.isArray(m.material)) m.material[i] = c;
          else m.material = c;
          this.playerTail.push(c);
        } else if (name.startsWith("headlight_light") || name === "light") {
          const c = (mat as THREE.MeshStandardMaterial).clone();
          c.emissive = new THREE.Color(0xfff2e0);
          c.emissiveIntensity = 0.4;
          if (Array.isArray(m.material)) m.material[i] = c;
          else m.material = c;
          this.playerHead.push(c);
        } else if (name === "exhaust") {
          box.setFromObject(m);
          const c = box.getCenter(new THREE.Vector3());
          c.z = box.max.z;
          exhausts.push(c);
        }
      });
    });
    const tips = exhausts.length
      ? exhausts
      : [new THREE.Vector3(-0.22, 0.78, 2.45), new THREE.Vector3(0, 0.78, 2.45), new THREE.Vector3(0.22, 0.78, 2.45)];
    for (const tip of tips) this.flames.push(this.makeFlame(car, tip));
    this.headL.position.set(-0.7, 0.75, -2.2);
    this.headR.position.set(0.7, 0.75, -2.2);
    if (!this.low) car.add(this.headL, this.headR);
    this.headL.target.position.set(-0.9, 0, -30);
    this.headR.target.position.set(0.9, 0, -30);
    if (!this.low) car.add(this.headL.target, this.headR.target);
    // Soft contact shadows keep the car grounded without another render pass.
    this.addContactShadow(car, 2.1, 4.8);
    for (const x of [-0.7, 0.7]) {
      const beam = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 25), new THREE.MeshBasicMaterial({ map: this.sparkTex, color: 0xffefd0, transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending }));
      beam.rotation.x = -Math.PI / 2;
      beam.position.set(x, 0.025, -14);
      beam.name = "road-beam";
      car.add(beam);
    }
    this.player = car;
    this.scene.add(car);
  }

  private makeFlame(car: THREE.Group, tip: THREE.Vector3): Flame {
    const g = new THREE.Group();
    g.position.copy(tip);
    const mk = (radius: number, core: number) => {
      const geo = new THREE.CylinderGeometry(radius * 0.25, radius, 1, this.low ? 10 : 20, this.low ? 5 : 12, true);
      // base at the tip, flame extends along +Z (backward)
      geo.translate(0, 0.5, 0);
      geo.rotateX(Math.PI / 2);
      // cylinder uv.y runs 0 at bottom (wide base) to 1 at top; after the
      // rotation the base sits at the tip — flip so 0 = tip.
      const mat = new THREE.ShaderMaterial({
        vertexShader: flameVert,
        fragmentShader: flameFrag,
        uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uSeed: { value: Math.random() * 10 }, uCore: { value: core } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      g.add(mesh);
      return { mesh, mat };
    };
    const outer = mk(0.11, 0);
    const core = mk(0.05, 1);
    core.mesh.scale.set(1, 1, 0.45);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: radialTex([
          [0, "rgba(255,190,110,1)"],
          [0.35, "rgba(255,110,30,0.45)"],
          [1, "rgba(255,60,0,0)"],
        ]),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    glow.scale.setScalar(0.6);
    glow.position.z = 0.15;
    g.add(glow);
    const light = new THREE.PointLight(0xff7a2a, 0, 7, 2);
    light.position.z = 0.4;
    if (!this.low) g.add(light);
    g.visible = false;
    car.add(g);
    return { group: g, outer: outer.mat, core: core.mat, glow, light };
  }

  private setupPolice(car: THREE.Group) {
    const box = new THREE.Box3().setFromObject(car);
    const top = box.max.y;
    this.policeBarR = new THREE.MeshBasicMaterial({ color: 0xff1020 });
    this.policeBarB = new THREE.MeshBasicMaterial({ color: 0x1040ff });
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.25), this.policeBarR);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.25), this.policeBarB);
    r.position.set(-0.3, top + 0.04, 0.2);
    b.position.set(0.3, top + 0.04, 0.2);
    this.policeRed.position.set(-0.4, top + 0.4, 0.2);
    this.policeBlue.position.set(0.4, top + 0.4, 0.2);
    car.add(r, b);
    if (!this.low) car.add(this.policeRed, this.policeBlue);
    this.addContactShadow(car, 2, 4.6);
    car.visible = false;
    this.police = car;
    this.scene.add(car);
  }

  private takeRig(model: ModelKey): CarRig | null {
    const free = this.pool.get(model)?.pop();
    if (free) {
      free.root.visible = true;
      return free;
    }
    const tpl = this.templates.get(model);
    if (!tpl) return null;
    const root = tpl.clone(true);
    this.addContactShadow(root, 2, 4.6);
    const box = new THREE.Box3().setFromObject(root);
    const rearZ = box.max.z - 0.02;
    const w = (box.max.x - box.min.x) / 2;
    const lampGeo = new THREE.BoxGeometry(0.34, 0.09, 0.04);
    const tail: THREE.Mesh[] = [];
    for (const s of [-1, 1]) {
      const l = new THREE.Mesh(lampGeo, this.tailMatOff);
      l.position.set(s * (w - 0.3), 0.85, rearZ);
      root.add(l);
      tail.push(l);
    }
    const blinkGeo = new THREE.BoxGeometry(0.12, 0.08, 0.04);
    const blinkL = new THREE.Mesh(blinkGeo, this.blinkMat.clone());
    const blinkR = new THREE.Mesh(blinkGeo, this.blinkMat.clone());
    blinkL.position.set(-(w - 0.08), 0.85, rearZ);
    blinkR.position.set(w - 0.08, 0.85, rearZ);
    root.add(blinkL, blinkR);
    this.scene.add(root);
    return { root, tail, blinkL, blinkR, model };
  }

  private releaseRig(rig: CarRig) {
    rig.root.visible = false;
    let list = this.pool.get(rig.model);
    if (!list) this.pool.set(rig.model, (list = []));
    list.push(rig);
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- per frame ----------
  render = (s: RenderSnapshot) => {
    const now = performance.now();
    if (this.lastFrame && this.low && this.quality.sample((now - this.lastFrame) / 1000, document.hidden)) {
      this.renderer.setPixelRatio(this.baseDpr * this.quality.scale);
      this.renderer.setSize(this.width, this.height, false);
    }
    this.lastFrame = now;
    const dt = Math.min(s.dt, 0.05);
    this.time += dt;
    const { ppm } = s;
    const toX = (x: number) => (x - s.roadCenterX) / ppm;
    const toZ = (y: number) => (y - s.baseY) / ppm;
    const pz = s.pz;

    const night = nightAmount(pz);
    const rain = rainAmount(pz);
    const tunnel = inTunnel(pz);
    const lights = lightsOn(pz) || s.highBeam;

    // --- sky, fog, light levels
    const dusk = Math.min(1, night * 2) * (1 - night);
    this.sky.copy(this.dayColor).lerp(this.duskColor, dusk * 0.8).lerp(this.nightColor, night);
    this.sky.lerp(this.rainColor, rain * 0.6 * (1 - night));
    const tunnelBlend = this.tunnelFactor(pz);
    this.fog.color.copy(this.sky).lerp(this.tunnelColor, tunnelBlend);
    this.fog.near = lerp(60, 25, Math.max(rain, night * 0.5));
    this.fog.far = lerp(VIEW_AHEAD - 10, 150, rain);
    this.sun.intensity = lerp(2.6, 0.04, night) * (1 - rain * 0.6) * (1 - tunnelBlend);
    this.hemi.intensity = lerp(0.95, 0.38, night) * (1 - rain * 0.2) * lerp(1, 0.65, tunnelBlend);
    this.scene.environmentIntensity = lerp(0.9, 0.12, night) * lerp(1, 0.35, tunnelBlend);
    this.roadMat.roughness = lerp(0.88, 0.25, rain);
    this.roadMat.color.setScalar(lerp(1, 0.55, rain));
    this.tunnelLamp.intensity = tunnel ? 28 + Math.sin((pz % 8) / 8 * Math.PI * 2) * 10 : 0;

    const px = s.player.x;
    const playerX = toX(px);
    // --- scrolling ground
    this.roadTex.offset.y = (pz / TILE_LEN) % 1;
    this.grassTex.offset.y = (pz / 8) % 1;
    this.layoutScenery(pz, night);
    this.placeLandmarks(pz);

    // --- sun follows the player for crisp shadows
    this.sun.position.set(playerX + 8, 22, -6);
    this.sun.target.position.set(playerX, 0, -8);

    // --- player
    if (this.player) {
      const p = this.player;
      p.position.set(playerX, 0, 0);
      p.rotation.y = -s.player.rot;
      // body roll / pitch from steering + throttle
      p.rotation.z = s.player.rot * 0.25;
      for (const m of this.playerTail) m.emissiveIntensity = s.braking ? 4.5 : lights ? 1.6 : 0.5;
      for (const m of this.playerHead) m.emissiveIntensity = lights ? 3 : 0.6;
      for (const child of p.children) if (child.name === "road-beam") child.visible = lights;
      const beam = s.highBeam ? 260 : lights ? 120 : 0;
      this.headL.intensity = this.headR.intensity = beam;
      this.headL.distance = this.headR.distance = s.highBeam ? 160 : 90;
      this.updateFlames(s, dt);
    }

    // --- traffic
    const seen = this.seen;
    seen.clear();
    for (const t of s.traffic) {
      const z = toZ(t.y);
      if (z < -(this.low ? 150 : VIEW_AHEAD + 20) || z > VIEW_BEHIND) continue;
      seen.add(t);
      let rig = this.active.get(t);
      if (!rig) {
        const r = this.takeRig(TYPE_MODEL[t.type]);
        if (!r) continue;
        rig = r;
        this.active.set(t, rig);
      }
      rig.root.position.set(toX(t.x), 0, z);
      rig.root.rotation.y = -t.rot;
      const blink = Math.floor(t.signalTimer * 2.6) % 2 === 0;
      (rig.blinkL.material as THREE.MeshStandardMaterial).emissiveIntensity = t.signal === -1 && blink ? 5 : 0;
      (rig.blinkR.material as THREE.MeshStandardMaterial).emissiveIntensity = t.signal === 1 && blink ? 5 : 0;
    }
    this.tailMatOff.emissiveIntensity = lights ? 3.2 : 0.7;
    for (const [car, rig] of this.active) {
      if (!seen.has(car)) {
        this.releaseRig(rig);
        this.active.delete(car);
      }
    }

    // --- police
    if (this.police) {
      const pol = s.police;
      const z = toZ(pol.y);
      const show = pol.active && z > -VIEW_AHEAD && z < VIEW_BEHIND + 20;
      this.police.visible = show;
      if (show) {
        this.police.position.set(toX(pol.x), 0, z);
        this.police.rotation.y = -pol.rot;
        const ph = Math.floor(this.time * 7) % 2;
        this.policeRed.intensity = ph ? 40 : 0;
        this.policeBlue.intensity = ph ? 0 : 40;
        this.policeBarR.color.setHex(ph ? 0xff2030 : 0x300408);
        this.policeBarB.color.setHex(ph ? 0x0a1440 : 0x2050ff);
      }
    }

    this.updateParticles(s, toX, toZ);
    this.updateRain(rain, dt, s.player.speed, tunnel);

    // --- chase camera
    this.camX = lerp(this.camX, playerX, 1 - Math.exp(-6 * dt));
    const speedK = Math.min(1, s.player.speed / 340);
    const fov = 60 + speedK * 12;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const sh = s.shake * 0.012;
    this.camera.position.set(this.camX * 0.9 + (Math.random() - 0.5) * sh, 2.05 - speedK * 0.25 + (Math.random() - 0.5) * sh, 6.6 - speedK * 0.8);
    this.camera.lookAt(this.camX * 0.95, 0.85, -16);

    // flash / police danger overlay
    if (this.overlay) {
      const gap = s.pz - (s.police.y ? 0 : 0);
      void gap;
      this.overlay.style.opacity = String(Math.min(0.6, s.flash * 0.6));
    }

    this.renderer.render(this.scene, this.camera);
    if (import.meta.env.DEV) {
      this.canvas.dataset["drawCalls"] = String(this.renderer.info.render.calls);
      this.canvas.dataset["triangles"] = String(this.renderer.info.render.triangles);
      this.canvas.dataset["quality"] = `${this.low ? "mobile" : "standard"}:${this.quality.scale.toFixed(2)}`;
    }
    if (!this.ready && this.player) {
      this.ready = true;
      this.onReady?.();
    }
  };

  /** 0 outside, 1 deep in the tunnel; ramps over the first/last 25 m. */
  private tunnelFactor(pz: number) {
    const u = cyc(pz);
    if (u < TUNNEL_FROM - 5 || u > TUNNEL_TO + 5) return 0;
    const a = Math.min(1, (u - TUNNEL_FROM + 5) / 25);
    const b = Math.min(1, (TUNNEL_TO + 5 - u) / 25);
    return Math.max(0, Math.min(a, b));
  }

  private nearest(pz: number, at: number) {
    // world z of the nearest occurrence of cycle position `at` (ahead or just behind)
    const base = pz - cyc(pz);
    let z = base + at;
    if (z < pz - VIEW_BEHIND - 40) z += CYCLE;
    return -(z - pz);
  }

  private placeLandmarks(pz: number) {
    // tunnel
    const len = TUNNEL_TO - TUNNEL_FROM;
    const base = pz - cyc(pz);
    let start = base + TUNNEL_FROM;
    if (start + len < pz - VIEW_BEHIND) start += CYCLE;
    const tz = -(start - pz);
    this.tunnel.position.z = tz;
    this.tunnel.visible = tz > -VIEW_AHEAD - 10 && tz - len < VIEW_BEHIND;

    const placeSet = (objs: THREE.Group[], positions: number[]) => {
      const zs = positions.map((p) => this.nearest(pz, p)).filter((z) => z > -VIEW_AHEAD && z < VIEW_BEHIND).sort((a, b) => b - a);
      objs.forEach((o, i) => {
        const z = zs[i];
        o.visible = z !== undefined;
        if (z !== undefined) o.position.z = z;
      });
    };
    placeSet(this.bridges, BRIDGES.map(([a, b]) => (a + b) / 2));
    placeSet(this.gantries, SIGN_GANTRIES);
    placeSet(this.radars, SPEED_RADARS);
  }

  private layoutScenery(pz: number, night: number) {
    const m = this.matrix;
    const q = this.quaternion;
    const sc = this.scaleVector;
    const pos = this.positionVector;
    const tunnelAt = (z: number) => inTunnel(z);

    // guardrail posts every 4 m
    let i = 0;
    const first = Math.floor((pz - VIEW_BEHIND) / 4);
    for (let n = first; i < 159; n++) {
      const z = n * 4;
      if (z > pz + 160) break;
      for (const s of [-1, 1]) {
        m.makeTranslation(s * (DECK_W / 2 + 0.55), 0, -(z - pz));
        this.posts.setMatrixAt(i++, m);
      }
    }
    this.posts.count = i;
    this.posts.instanceMatrix.needsUpdate = true;

    // trees: one slot every 7 m per side, skipped in tunnels
    i = 0;
    const tFirst = Math.floor((pz - VIEW_BEHIND) / 7);
    for (let n = tFirst; i < 139; n++) {
      const z = n * 7;
      if (z > pz + VIEW_AHEAD) break;
      for (const s of [-1, 1]) {
        const hsh = hash(n * 2 + (s > 0 ? 1 : 0));
        if (hsh < 0.25 || tunnelAt(z)) continue;
        const x = s * (DECK_W / 2 + 6 + hsh * 26);
        const k = 0.7 + hash(n * 7.3 + s) * 0.9;
        pos.set(x, 0, -(z - pz));
        sc.set(k, k * (0.9 + hsh * 0.5), k);
        q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, hsh * 6);
        m.compose(pos, q, sc);
        this.trunks.setMatrixAt(i, m);
        this.crowns.setMatrixAt(i, m);
        i++;
      }
    }
    this.trunks.count = this.crowns.count = i;
    this.trunks.instanceMatrix.needsUpdate = this.crowns.instanceMatrix.needsUpdate = true;

    // street lamps every 45 m alternating sides
    i = 0;
    const lFirst = Math.floor((pz - VIEW_BEHIND) / 45);
    for (let n = lFirst; i < 24; n++) {
      const z = n * 45;
      if (z > pz + VIEW_AHEAD) break;
      if (tunnelAt(z)) continue;
      const s = n % 2 === 0 ? -1 : 1;
      const x = s * (DECK_W / 2 + 1.4);
      pos.set(x, 0, -(z - pz));
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, 0);
      sc.set(1, 1, 1);
      m.compose(pos, q, sc);
      this.lampPoles.setMatrixAt(i, m);
      m.makeTranslation(x - s * 0.8, 0, -(z - pz));
      this.lampHeads.setMatrixAt(i, m);
      m.makeTranslation(x - s * 3.2, 0, -(z - pz));
      this.lampPools.setMatrixAt(i, m);
      i++;
    }
    this.lampPoles.count = this.lampHeads.count = this.lampPools.count = i;
    this.lampPoles.instanceMatrix.needsUpdate = this.lampHeads.instanceMatrix.needsUpdate = this.lampPools.instanceMatrix.needsUpdate = true;
    const lampOn = Math.max(0, (night - 0.25) / 0.75);
    this.lampHeadMat.emissiveIntensity = lampOn * 4;
    this.lampPoolMat.opacity = lampOn * 0.55;
  }

  private updateFlames(s: RenderSnapshot, dt: number) {
    // Shift pops (timer) and sustained boost give the big jet; lifting off at
    // high rpm gives short random crackles.
    let target = 0;
    let len = 0;
    if (s.boostActive) {
      target = 1;
      len = 1.05 + Math.random() * 0.45;
    } else if (s.exhaustFlame > 0) {
      target = Math.min(1, s.exhaustFlame / 0.18);
      len = 0.6 + Math.random() * 0.6;
    } else if (!s.gas && s.player.speed > 120 && s.phase === "playing") {
      this.popT -= dt;
      if (this.popT <= 0) {
        this.popT = 0.08 + Math.random() * 0.35;
        if (Math.random() < 0.45) {
          target = 0.55;
          len = 0.3 + Math.random() * 0.3;
        }
      }
    }
    this.flameAmt = target > this.flameAmt ? target : this.flameAmt * Math.exp(-14 * dt);
    this.flameLen = len > 0 ? len : this.flameLen * Math.exp(-8 * dt);
    const on = this.flameAmt > 0.02;
    for (const f of this.flames) {
      f.group.visible = on;
      if (!on) continue;
      const flick = 0.75 + Math.random() * 0.5;
      const L = Math.max(0.12, this.flameLen * flick);
      f.group.scale.set(1 + this.flameAmt * 0.3, 1 + this.flameAmt * 0.3, L);
      // keep the glow sprite round despite the group's z stretch
      f.glow.scale.set(0.55 * flick, 0.55 * flick, 0.55 / L);
      for (const mat of [f.outer, f.core]) {
        const time = mat.uniforms["uTime"];
        const intensity = mat.uniforms["uIntensity"];
        if (time) time.value = this.time;
        if (intensity) intensity.value = this.flameAmt * flick * 1.4;
      }
      f.light.intensity = this.flameAmt * flick * 14;
    }
  }

  private updateParticles(s: RenderSnapshot, toX: (x: number) => number, toZ: (y: number) => number) {
    let i = 0;
    for (const q of s.particles) {
      if (i >= this.sprites.length) break;
      if (q.kind === "flame") continue; // drawn by the 3D exhaust flames
      const sp = this.sprites[i++];
      if (!sp) break;
      const mat = sp.material;
      const life = q.life / q.max;
      sp.visible = true;
      sp.position.set(toX(q.x), 0.4 + (q.kind === "smoke" ? life * 2.4 : q.kind === "spark" ? 0.4 : 0.15), toZ(q.y));
      const size = (q.size / s.ppm) * (q.kind === "smoke" ? 2.2 : q.kind === "spark" ? 3 : 1.6);
      sp.scale.setScalar(Math.max(0.05, size));
      if (q.kind === "spark") {
        mat.map = this.sparkTex;
        mat.blending = THREE.AdditiveBlending;
        mat.color.setHex(0xffffff);
      } else {
        mat.map = this.smokeTex;
        mat.blending = THREE.NormalBlending;
        mat.color.setHex(q.kind === "spray" ? 0xd5dde6 : q.dark ? 0x2a2a2c : q.kind === "debris" ? 0x111111 : 0x9a9a9e);
      }
      mat.opacity = q.alpha * (1 - life);
    }
    for (; i < this.sprites.length; i++) {
      const sprite = this.sprites[i];
      if (sprite) sprite.visible = false;
    }
  }

  private updateRain(rain: number, dt: number, speed: number, tunnel: boolean) {
    const mat = this.rain.material as THREE.LineBasicMaterial;
    mat.opacity = tunnel ? 0 : rain * 0.55;
    this.rain.visible = mat.opacity > 0.01;
    if (!this.rain.visible) return;
    this.rain.position.x = this.camX;
    const fall = 22 * dt;
    const rush = (speed / 3.6) * dt;
    const a = this.rainPos;
    for (let i = 0; i < a.length / 6; i++) {
      const o = i * 6;
      a[o + 1] = (a[o + 1] ?? 0) - fall;
      a[o + 4] = (a[o + 4] ?? 0) - fall;
      a[o + 2] = (a[o + 2] ?? 0) + rush;
      a[o + 5] = (a[o + 5] ?? 0) + rush;
      if ((a[o + 1] ?? 0) < 0 || (a[o + 2] ?? 0) > 10) this.resetDrop(i, false);
    }
    (this.rain.geometry.attributes["position"] as THREE.BufferAttribute).needsUpdate = true;
  }

  private addContactShadow(car: THREE.Group, width: number, length: number) {
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width, length), new THREE.MeshBasicMaterial({ map: this.smokeTex, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.018;
    car.add(shadow);
  }

  dispose() {
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
  }
}
