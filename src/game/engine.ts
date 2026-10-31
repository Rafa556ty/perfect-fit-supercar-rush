import type { GameAudio } from "./audio";
import { pickGear } from "./gearbox";
import { ESCAPE_GAP, POLICE_MAX, START_DELAY, START_GAP, escapeProgress, policeSpeedStep, policeZone, isRearHit, choosePoliceLane, type Zone } from "./police";
import { blockedLanes, isLaneClear, laneChangeOk, wallSpeedCaps, type CarType, type LaneCar, type YieldState } from "./traffic";
import { BRIDGES, SIGN_GANTRIES, SPEED_RADARS, inTunnel, lightsOn, nightAmount, rainAmount } from "./world";

const WALL_LEN = 3.5;

export type GameInput = {
  left: boolean;
  right: boolean;
  gas: boolean;
  brake: boolean;
  horn: boolean;
  boost: boolean;
  highBeam: boolean;
};

export type HudData = {
  speed: number;
  distance: number;
  topSpeed: number;
  gear: number;
  inTunnel: boolean;
  nightAmount: number;
  rainAmount: number;
  boostEnergy: number;
  boostActive: boolean;
  nearMissCombo: number;
  nearMissEvent?: { combo: number; pts: number } | undefined;
  radarEvent?: { speed: number; limit: number } | undefined;
  policeGap?: number | undefined;
  policeZone?: Zone | undefined;
  escapeProgress?: number | undefined;
};

export type GameOverOutcome = "crash" | "busted" | "escaped";

export type EnginePhase = "menu" | "playing" | "crashed" | "busted" | "escaped" | "over";

export type CarAssetMap = {
  player: HTMLImageElement;
  police: HTMLImageElement;
  bus: HTMLImageElement;
  suv: HTMLImageElement;
  m5: HTMLImageElement;
  mustangBlue: HTMLImageElement;
  mustangBlack: HTMLImageElement;
  sedan: HTMLImageElement;
  hatch: HTMLImageElement;
  pickup: HTMLImageElement;
};

type TrafficCar = LaneCar & {
  x: number;
  y: number;
  w: number;
  h: number;
  cruise: number;
  originalCruise?: number;
  img: HTMLImageElement;
  type: CarType;
  rot: number;
  vr: number;
  vx: number;
  signal: -1 | 1 | 0;
  signalTimer: number;
  targetLane: number;
  yieldState: YieldState;
  nearMissed?: boolean;
};

type Particle = {
  kind: "smoke" | "spark" | "debris" | "flame" | "spray";
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  alpha: number;
  rot: number;
  dark?: boolean;
};

const LANES = 3;
export const MAX_SPEED = 352; // km/h (Revuelto top speed)
const ACCEL = 68;
const BRAKE = 135;
const COAST = 8;
const SCROLL = 0.3;
const STEER_LANES_PER_SEC = 3.5;
const TILE_H = 720;
const DASH_P = 90;

const C = {
  grass: "#41622b",
  grassDark: "#2f481e",
  grassLight: "#547a37",
  tree: "#223b18",
  treeLight: "#395b26",
  gravel: "#787165",
  asphalt: "#3f4146",
  asphaltLight: "#4d5056",
  asphaltDark: "#2c2e32",
  line: "#f0ece0",
  rail: "#b8bcc2",
  railShadow: "rgba(0,0,0,0.4)",
  post: "#686c72",
};

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export type RenderCar = {
  x: number; y: number; w: number; h: number; rot: number;
  type: CarType; hit?: boolean; signal: -1 | 1 | 0; signalTimer: number;
};

export type RenderParticle = { kind: Particle["kind"]; x: number; y: number; size: number; life: number; max: number; alpha: number; dark?: boolean };

/** Read-only view of the simulation that a 3D renderer draws each frame. */
export type RenderSnapshot = {
  phase: EnginePhase;
  mode: "free" | "police";
  /** pixels per world metre; sim coordinates are pixels */
  ppm: number;
  roadCenterX: number;
  baseY: number;
  pz: number;
  dt: number;
  player: { x: number; rot: number; speed: number; w: number; h: number };
  braking: boolean;
  gas: boolean;
  gear: number;
  boostActive: boolean;
  exhaustFlame: number;
  highBeam: boolean;
  shake: number;
  flash: number;
  traffic: readonly RenderCar[];
  police: { x: number; y: number; w: number; h: number; rot: number; active: boolean };
  particles: readonly RenderParticle[];
};

export class RacingEngine {
  /** When set, the 2D canvas renderer is skipped and this draws the frame instead (3D mode). */
  onRender?: (s: RenderSnapshot) => void;
  private threeD = false;
  private ctx: CanvasRenderingContext2D;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private bottomInset = 170;
  private raf = 0;
  private last = 0;

  phase: EnginePhase = "menu";
  mode: "free" | "police" = "free";
  input: GameInput = { left: false, right: false, gas: false, brake: false, horn: false, boost: false, highBeam: false };

  private roadX = 0;
  private roadW = 0;
  private laneW = 0;
  private carW = 0;
  private k = 10;
  private baseY = 0;
  private lenM = 14;

  private player = { x: 0, vx: 0, rot: 0, spin: 0, speed: 0, w: 0, h: 0 };
  private pz = 0;
  private distance = 0;
  private topSpeed = 0;
  private currentGear = 1; // 1-8
  private lastGear = 1;
  private exhaustFlameTimer = 0; // seconds remaining for shift flame
  private nextSpawnZ = 0;

  // Hybrid KERS Boost & High Beam & Near Miss & Radar Trap
  private boostEnergy = 100; // 0-100%
  private boostActive = false;
  private highBeamTimer = 0; // flasher duration
  private nearMissCombo = 0;
  private comboTimer = 0;
  private lastNearMissEvent?: { combo: number; pts: number } | undefined;
  private nearMissEventTimer = 0;
  private lastRadarEvent?: { speed: number; limit: number } | undefined;
  private radarEventTimer = 0;
  private passedRadars = new Set<number>();
  private rainSprayT = 0;

  // Police state
  private police = {
    x: 0,
    y: 0,
    z: -START_GAP,
    speed: 0,
    lane: 1,
    targetLane: 1,
    w: 0,
    h: 0,
    sirenT: 0,
    startDelay: START_DELAY,
    active: false,
    blocking: false,
    passLane: 1,
    vx: 0,
    rot: 0,
    holdT: 0,
  };

  private traffic: TrafficCar[] = [];
  private particles: Particle[] = [];
  private streaks: { x: number; y: number; len: number }[] = [];
  private scroll = 0;
  private shake = 0;
  private flash = 0;
  private crashT = 0;
  private emitT = 0;
  private hudT = 0;
  private hornActive = false;
  private gameOverOutcome: GameOverOutcome = "crash";

  private tileDay: HTMLCanvasElement | null = null;
  private shadow: HTMLCanvasElement;
  private smokeDark: HTMLCanvasElement;
  private smokeLight: HTMLCanvasElement;

  constructor(
    private canvas: HTMLCanvasElement,
    private images: CarAssetMap,
    private cb: {
      onHud: (h: HudData) => void;
      onGameOver: (r: { distance: number; topSpeed: number; outcome: GameOverOutcome }) => void;
      onNearMiss?: (combo: number, pts: number) => void;
      onRadarTrigger?: (speed: number) => void;
      onShift?: (gear: number) => void;
    },
    private audio?: GameAudio,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.shadow = this.makeShadow();
    this.smokeDark = this.makeSmoke(55, 55, 58);
    this.smokeLight = this.makeSmoke(185, 185, 188);
  }

  setBottomInset(px: number) {
    this.bottomInset = px;
    if (this.W) this.layout();
  }

  /** 3D mode: true-to-scale distances (1 sim metre = 1 world metre) and a long view ahead. */
  setThreeD(on: boolean) {
    this.threeD = on;
    if (this.W) this.layout();
  }

  /** Spacing unit for spawning and lane walls; matches the 2D game's gaps in 3D mode. */
  private get spanM() {
    return this.threeD ? this.lenM * 2.7 : this.lenM;
  }

  snapshot(dt: number): RenderSnapshot {
    const p = this.player;
    return {
      phase: this.phase,
      mode: this.mode,
      ppm: this.laneW / 3.6,
      roadCenterX: this.roadX + this.roadW / 2,
      baseY: this.baseY,
      pz: this.pz,
      dt,
      player: p,
      braking: this.input.brake && this.phase === "playing",
      gas: this.input.gas && this.phase === "playing",
      gear: this.currentGear,
      boostActive: this.boostActive,
      exhaustFlame: this.exhaustFlameTimer,
      highBeam: this.highBeamTimer > 0,
      shake: this.shake,
      flash: this.flash,
      traffic: this.traffic,
      police: { ...this.police, active: this.mode === "police" && this.police.active },
      particles: this.particles,
    };
  }

  /** Dev-only fixed stepping for checking the actual game on software WebGL. */
  debugSim(seconds: number) {
    if (!import.meta.env.DEV) return;
    for (let t = 0; t < Math.min(seconds, 120); t += 1 / 60) this.update(1 / 60);
    this.onRender?.(this.snapshot(1 / 60));
  }

  setMode(mode: "free" | "police") {
    this.mode = mode;
  }

  resize(w: number, h: number) {
    if (w < 20 || h < 20) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = w;
    this.H = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const prevLaneW = this.laneW;
    const prevRoadX = this.roadX;
    this.layout();
    if (prevLaneW) {
      const rel = (this.player.x - prevRoadX) / (prevLaneW * LANES);
      this.player.x = this.roadX + rel * this.roadW;
      for (const t of this.traffic) t.x = this.laneX(t.lane);
    } else {
      this.player.x = this.laneX(1);
    }
    this.buildTile();
    this.streaks = Array.from({ length: 18 }, () => ({
      x: rnd(0, w),
      y: rnd(0, h),
      len: rnd(50, 130),
    }));
  }

  private layout() {
    this.roadW = Math.min(this.W * 0.82, 530);
    this.roadX = (this.W - this.roadW) / 2;
    this.laneW = this.roadW / LANES;
    this.carW = this.laneW * 0.68;
    const p = this.player;
    p.w = this.carW;
    p.h = this.carW * (this.images.player.naturalHeight / this.images.player.naturalWidth);
    this.k = this.threeD ? this.laneW / 3.6 : (this.carW / 2.25) * SCROLL;
    this.lenM = p.h / this.k;
    this.baseY = this.H - this.bottomInset - p.h * 0.55 - 10;

    // Police sizing
    this.police.w = this.carW * 0.96;
    this.police.h = this.police.w * (this.images.police.naturalHeight / this.images.police.naturalWidth);

    for (const t of this.traffic) {
      if (this.threeD) continue;
      t.w = t.type === "bus" ? this.carW * 1.08 : this.carW * 0.95;
      t.h = t.w * (t.img.naturalHeight / t.img.naturalWidth);
    }
    if (this.threeD) {
      // Real-world footprints in 3D (metres -> px): the models are scaled to these.
      const ppm = this.laneW / 3.6;
      p.w = 2.05 * ppm; p.h = 4.95 * ppm;
      this.police.w = 1.95 * ppm; this.police.h = 4.8 * ppm;
      this.lenM = p.h / this.k;
    }
  }

  private laneX(lane: number) {
    return this.roadX + this.laneW * (lane + 0.5);
  }

  start() {
    this.phase = "playing";
    this.traffic = [];
    this.particles = [];
    const p = this.player;
    p.x = this.laneX(1);
    p.vx = 0;
    p.rot = 0;
    p.spin = 0;
    p.speed = 0;
    this.pz = 0;
    this.distance = 0;
    this.topSpeed = 0;
    this.currentGear = 1;
    this.lastGear = 1;
    this.exhaustFlameTimer = 0;
    this.crashT = 0;
    this.shake = 0;
    this.flash = 0;
    this.gameOverOutcome = "crash";
    this.nextSpawnZ = (this.baseY + 260) / this.k;

    // Reset gameplay enhancements
    this.boostEnergy = 100;
    this.boostActive = false;
    this.highBeamTimer = 0;
    this.nearMissCombo = 0;
    this.comboTimer = 0;
    this.lastNearMissEvent = undefined;
    this.nearMissEventTimer = 0;
    this.lastRadarEvent = undefined;
    this.radarEventTimer = 0;
    this.passedRadars.clear();
    this.rainSprayT = 0;

    // Reset police pursuit
    this.police.z = -START_GAP;
    this.police.speed = 0;
    this.police.lane = 1;
    this.police.targetLane = 1;
    this.police.x = this.laneX(1);
    this.police.startDelay = START_DELAY;
    this.police.active = this.mode === "police";
    this.police.blocking = false;
    this.police.vx = 0;
    this.police.rot = 0;
    this.police.holdT = 0;
  }

  run() {
    const loop = (now: number) => {
      const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
      this.last = now;
      this.raf = requestAnimationFrame(loop);
      if (!this.W || !this.H) return;
      try {
        this.update(dt);
        if (this.onRender) this.onRender(this.snapshot(dt));
        else this.render();
      } catch (err) {
        console.warn("frame error", err);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.audio?.setEngine(0, false, false);
    this.audio?.stopHorn();
    this.audio?.setPolice(999, false);
    this.audio?.setBoost(false);
  }

  // ---------- simulation ----------
  private update(dt: number) {
    const p = this.player;
    const inp = this.input;
    const minX = this.roadX + 10 + p.w * 0.4;
    const maxX = this.roadX + this.roadW - 10 - p.w * 0.4;

    // Horn input check
    if (inp.horn && !this.hornActive) {
      this.hornActive = true;
      this.audio?.startHorn(inTunnel(this.pz));
      this.triggerHornYield();
    } else if (!inp.horn && this.hornActive) {
      this.hornActive = false;
      this.audio?.stopHorn();
    }

    // High-beam flasher input check
    if (inp.highBeam && this.highBeamTimer <= 0) {
      this.highBeamTimer = 0.75;
      this.triggerHighBeamAlert();
    }
    if (this.highBeamTimer > 0) {
      this.highBeamTimer -= dt;
    }

    if (this.phase === "menu") {
      p.speed += (95 - p.speed) * (1 - Math.exp(-dt));
      p.x += (this.laneX(1) - p.x) * (1 - Math.exp(-3 * dt));
      this.currentGear = 2;
    } else if (this.phase === "playing") {
      let a: number;
      if (inp.brake) {
        a = -BRAKE;
        this.boostActive = false;
        this.audio?.setBoost(false);
        this.boostEnergy = Math.min(100, this.boostEnergy + 4 * dt);
      } else {
        const isBoosting = inp.boost && this.boostEnergy > 2;
        if (isBoosting) {
          this.boostActive = true;
          this.boostEnergy = Math.max(0, this.boostEnergy - 28 * dt);
          this.audio?.setBoost(true);
          const boostForce = 85 * (1 - (p.speed / (MAX_SPEED + 12)) ** 1.3);
          a = ACCEL * (1 - (p.speed / MAX_SPEED) ** 2) + boostForce + 6.0;
          this.exhaustFlameTimer = 0.22;
          this.shake = Math.max(this.shake, 1.25);
        } else {
          this.boostActive = false;
          this.audio?.setBoost(false);
          this.boostEnergy = Math.min(100, this.boostEnergy + 5.5 * dt);
          if (inp.gas) {
            a = ACCEL * (1 - (p.speed / MAX_SPEED) ** 2) + 3.5;
          } else {
            a = -(COAST + p.speed * 0.04);
          }
        }
      }
      p.speed = clamp(p.speed + a * dt, 0, MAX_SPEED);

      // Gearbox computation (8-speed, 1-indexed)
      const g0 = pickGear(this.currentGear - 1, p.speed, inp.gas || this.boostActive);
      const newGear = g0 + 1;
      if (newGear > this.currentGear && (inp.gas || this.boostActive)) {
        // Requirement 1: Flame appears on shift into even gears (2, 4, 6, 8)
        if (newGear % 2 === 0) {
          this.exhaustFlameTimer = 0.28;
          this.audio?.fireExhaustBackfire();
          this.emitExhaustParticles();
        }
        this.cb.onShift?.(newGear);
      }
      this.currentGear = newGear;
      this.lastGear = newGear;

      const steer = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      const steerSpeed = this.laneW * STEER_LANES_PER_SEC;
      const grip = Math.min(1, p.speed / 35);
      const target = steer * steerSpeed * grip;
      p.vx += (target - p.vx) * (1 - Math.exp(-10 * dt));
      p.x += p.vx * dt;
      p.rot = (p.vx / steerSpeed) * 0.14;

      if (p.x < minX || p.x > maxX) {
        const side = p.x < minX ? -1 : 1;
        p.x = clamp(p.x, minX, maxX);
        if (p.speed > 20 && steer === side) {
          p.speed = Math.max(0, p.speed - 45 * dt);
          this.emitSparks(p.x + side * p.w * 0.45, this.baseY + rnd(-p.h * 0.3, p.h * 0.3), 1, side);
          this.shake = Math.max(this.shake, 2.5);
        }
        p.vx = 0;
      }
    } else if (this.phase === "busted") {
      // PRESO: the car brakes automatically until it stops — no explosion
      p.speed = Math.max(0, p.speed - 150 * dt);
      p.rot *= Math.exp(-6 * dt);
      p.spin = 0;
      p.vx *= Math.exp(-6 * dt);
      p.x = clamp(p.x, minX, maxX);
      this.crashT += dt;
      if (p.speed <= 0.5 && this.crashT > 0.5) {
        this.phase = "over";
        this.gameOverOutcome = "busted";
        this.cb.onGameOver({ distance: this.distance, topSpeed: this.topSpeed, outcome: "busted" });
      }
    } else {
      // Crashed / Escaped ending dynamics
      p.speed *= Math.exp(-1.8 * dt);
      if (p.speed < 1) p.speed = 0;
      p.rot += p.spin * dt;
      p.spin *= Math.exp(-1.6 * dt);
      p.x += p.vx * dt;
      p.vx *= Math.exp(-2.5 * dt);
      if (p.x < minX || p.x > maxX) {
        p.x = clamp(p.x, minX, maxX);
        p.vx = -p.vx * 0.3;
      }
      this.crashT += dt;
      this.emitT += dt;
      const rate = this.crashT < 3 ? 0.025 : 0.06;
      while (this.emitT > rate) {
        this.emitT -= rate;
        const r = p.h * 0.22;
        this.emitSmoke(p.x - Math.sin(p.rot) * r, this.baseY + Math.cos(p.rot) * r, this.crashT < 2 && Math.random() < 0.35);
      }
      if ((this.phase === "crashed" || this.phase === "escaped") && this.crashT > 1.4) {
        const out = this.phase === "crashed" ? "crash" : "escaped";
        this.phase = "over";
        this.gameOverOutcome = out;
        this.cb.onGameOver({ distance: this.distance, topSpeed: this.topSpeed, outcome: out });
      }
    }

    if (this.phase === "playing") this.topSpeed = Math.max(this.topSpeed, p.speed);
    const ds = (p.speed / 3.6) * dt;
    this.pz += ds;
    if (this.phase === "playing") this.distance += ds;
    const dsPx = ds * this.k;
    this.scroll = (this.scroll + dsPx) % TILE_H;

    // Decay exhaust flame timer
    if (this.exhaustFlameTimer > 0) {
      this.exhaustFlameTimer -= dt;
      if (Math.random() < 0.4) this.emitExhaustParticles();
    }

    this.updateTraffic(dt);
    if (this.phase === "playing") {
      this.spawn();
      this.checkCollision();
    }

    // Police Pursuit Update
    if (this.mode === "police" && (this.phase === "playing" || this.phase === "busted")) {
      this.updatePolice(dt);
    }

    // Near Miss combo timer & detection
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.nearMissCombo = 0;
      }
    }
    if (this.nearMissEventTimer > 0) {
      this.nearMissEventTimer -= dt;
      if (this.nearMissEventTimer <= 0) {
        this.lastNearMissEvent = undefined;
      }
    }
    if (this.radarEventTimer > 0) {
      this.radarEventTimer -= dt;
      if (this.radarEventTimer <= 0) {
        this.lastRadarEvent = undefined;
      }
    }

    if (this.phase === "playing" && p.speed > 115) {
      for (const t of this.traffic) {
        if (t.hit || t.nearMissed) continue;
        const dz = Math.abs(t.z - this.pz);
        if (dz < this.lenM * 0.72) {
          const latDist = Math.abs(t.x - p.x);
          const minSafe = (p.w + t.w) * 0.44;
          const maxClose = (p.w + t.w) * 0.75;
          if (latDist >= minSafe && latDist <= maxClose) {
            t.nearMissed = true;
            this.nearMissCombo += 1;
            this.comboTimer = 3.0;
            const pts = 100 * this.nearMissCombo;
            this.boostEnergy = Math.min(100, this.boostEnergy + 18);
            this.lastNearMissEvent = { combo: this.nearMissCombo, pts };
            this.nearMissEventTimer = 1.8;
            this.audio?.playNearMissWhoosh();
            this.cb.onNearMiss?.(this.nearMissCombo, pts);
            const side = t.x > p.x ? 1 : -1;
            for (let k = 0; k < 6; k++) {
              this.particles.push({
                kind: "spark",
                x: p.x + side * (p.w * 0.45),
                y: this.baseY + rnd(-p.h * 0.3, p.h * 0.3),
                vx: side * rnd(40, 90),
                vy: rnd(-60, 60),
                life: 0,
                max: 0.25,
                size: rnd(2, 4),
                grow: 0,
                alpha: 0.9,
                rot: 0,
              });
            }
          }
        }
      }
    }

    // Speed Radar Cameras check
    if (this.phase === "playing") {
      for (const rz of SPEED_RADARS) {
        if (this.pz >= rz && this.pz < rz + 18 && !this.passedRadars.has(rz)) {
          this.passedRadars.add(rz);
          if (p.speed > 210) {
            this.flash = 1.0;
            this.audio?.playCameraShutter();
            this.lastRadarEvent = { speed: Math.round(p.speed), limit: 120 };
            this.radarEventTimer = 2.2;
            this.cb.onRadarTrigger?.(Math.round(p.speed));
          }
        }
      }
    }

    const playing = this.phase === "playing";
    const tunnel = inTunnel(this.pz);
    const rain = rainAmount(this.pz);

    // Wet tire spray particles during rain
    if (playing && rain > 0.08 && p.speed > 35) {
      this.rainSprayT += dt;
      if (this.rainSprayT > 0.045) {
        this.rainSprayT = 0;
        for (const sx of [-1, 1]) {
          this.particles.push({
            kind: "spray",
            x: p.x + sx * (p.w * 0.32),
            y: this.baseY + p.h * 0.44,
            vx: sx * rnd(10, 35) + rnd(-10, 10),
            vy: rnd(50, 140) + p.speed * 0.6,
            life: 0,
            max: rnd(0.25, 0.45),
            size: rnd(4, 9),
            grow: rnd(15, 25),
            alpha: 0.45 * rain,
            rot: rnd(0, 6.28),
          });
        }
      }
    }

    this.updateParticles(dt, dsPx);

    for (const s of this.streaks) {
      s.y += dsPx * 1.8;
      if (s.y > this.H + s.len) {
        s.y = -s.len;
        s.x = rnd(0, this.W);
      }
    }

    this.shake *= Math.exp(-6 * dt);
    this.flash *= Math.exp(-5 * dt);

    this.audio?.setEngine(playing ? p.speed : 0, (inp.gas || this.boostActive) && playing, playing, tunnel, rain, this.currentGear - 1);

    this.hudT += dt;
    if (this.hudT > 0.08) {
      this.hudT = 0;
      const gap = this.pz - this.police.z;
      this.cb.onHud({
        speed: p.speed,
        distance: this.distance,
        topSpeed: this.topSpeed,
        gear: this.currentGear,
        inTunnel: tunnel,
        nightAmount: nightAmount(this.pz),
        rainAmount: rain,
        boostEnergy: Math.round(this.boostEnergy),
        boostActive: this.boostActive,
        nearMissCombo: this.nearMissCombo,
        nearMissEvent: this.lastNearMissEvent,
        radarEvent: this.lastRadarEvent,
        policeGap: this.mode === "police" ? gap : undefined,
        policeZone: this.mode === "police" ? policeZone(gap) : undefined,
        escapeProgress: this.mode === "police" ? escapeProgress(gap) : undefined,
      });
    }
  }

  // ---------- High-Beam Projector Alert ----------
  private triggerHighBeamAlert() {
    const p = this.player;
    const pLane = clamp(Math.floor((p.x - this.roadX) / this.laneW), 0, LANES - 1);
    for (const t of this.traffic) {
      if (t.hit) continue;
      const dz = t.z - this.pz;
      if (dz > 10 && dz < 220) {
        if (t.lane === pLane || Math.abs(t.x - p.x) < this.carW * 1.1) {
          if (t.yieldState !== "changing") {
            t.originalCruise = t.originalCruise ?? t.cruise;
            const candidates: number[] = [];
            if (t.lane > 0 && t.lane - 1 !== pLane) candidates.push(t.lane - 1);
            if (t.lane < LANES - 1 && t.lane + 1 !== pLane) candidates.push(t.lane + 1);
            if (candidates.length === 0) {
              if (t.lane > 0) candidates.push(t.lane - 1);
              if (t.lane < LANES - 1) candidates.push(t.lane + 1);
            }
            if (candidates.length > 0) {
              const target = candidates.find((l) => isLaneClear(this.traffic, t, l, 14, 12)) ?? candidates[0]!;
              t.targetLane = target;
              t.signal = target < t.lane ? -1 : 1;
              t.signalTimer = 0;
              t.yieldState = isLaneClear(this.traffic, t, target, 14, 12) ? "changing" : "accelerating";
            }
          }
        }
      }
    }
  }

  // ---------- Police Escape Mode Logic ----------
  private updatePolice(dt: number) {
    const pol = this.police;
    pol.sirenT += dt;

    if (pol.startDelay > 0) {
      pol.startDelay -= dt;
      pol.z = this.pz - START_GAP;
      pol.speed = 100;
    } else {
      const pLane = clamp(Math.floor((this.player.x - this.roadX) / this.laneW), 0, LANES - 1);
      const settled = Math.abs(pol.x - this.laneX(pol.lane)) < this.laneW * 0.15;
      // Pick a lane only once the previous change finished: overtake via free lanes, never through cars
      if (settled) {
        pol.targetLane = choosePoliceLane(this.traffic, { lane: pol.lane, z: pol.z }, pLane, {
          ahead: this.lenM * 3,
          behind: this.lenM * 1.6,
        });
        pol.lane = pol.targetLane;
      }

      // Respect traffic: never faster than a car right ahead in the lanes it occupies
      let speedCap = POLICE_MAX;
      for (const t of this.traffic) {
        if (t.hit) continue;
        const dz = t.z - pol.z;
        if (dz > 0 && dz < this.lenM * 2.6 && Math.abs(t.x - pol.x) < this.carW * 0.95) {
          speedCap = Math.min(speedCap, dz < this.lenM * 1.15 ? t.speed * 0.85 : t.speed);
        }
      }

      const gapNow = this.pz - pol.z;
      const ps = this.player.speed;
      if (this.phase === "busted") {
        // Roadblock done: the police car brakes to a stop in front, no crash
        pol.speed = Math.max(0, pol.speed - 150 * dt);
        pol.lane = pLane;
        this.player.spin = 0;
        this.player.rot *= Math.exp(-4 * dt);
      } else {
        // Close enough: go for a rolling roadblock (overtake beside, cut in, brake)
        if (!pol.blocking && gapNow < this.lenM * 2.2) {
          pol.blocking = true;
          const side = pLane === 0 ? 1 : pLane === LANES - 1 ? LANES - 2 : pol.lane !== pLane ? pol.lane : pLane + (Math.random() < 0.5 ? -1 : 1);
          pol.passLane = side;
        }
        if (pol.blocking) {
          const ahead = pol.z - this.pz;
          if (ahead < this.lenM * 1.4) {
            // Pull alongside in the free lane and overtake
            pol.lane = pol.passLane;
            pol.speed = Math.min(340, Math.max(pol.speed, ps + 45));
          } else {
            // In front: cut into the player's lane and brake hard
            pol.lane = pLane;
            pol.speed = Math.max(0, Math.min(pol.speed, ps) - 110 * dt);
          }
          if (Math.abs(pol.x - this.player.x) > this.carW * 0.75) pol.holdT = 0;
          if (gapNow > this.lenM * 6) pol.blocking = false; // player got away
        } else {
          pol.speed = policeSpeedStep(pol.speed, dt, speedCap);
        }
      }
      pol.z += (pol.speed / 3.6) * dt;
      const targetX = this.laneX(pol.lane);
      // Realistic steering: lateral speed is limited so a lane change takes
      // real time, and the heading follows the actual direction of travel
      // (the car visibly turns into the lane instead of sliding sideways).
      const dx = targetX - pol.x;
      const maxVx = this.laneW * (0.55 + Math.min(pol.speed, 220) / 260);
      const wantVx = clamp(dx * 2.2, -maxVx, maxVx);
      pol.vx += (wantVx - pol.vx) * (1 - Math.exp(-5 * dt));
      pol.x += pol.vx * dt;
      const fwd = Math.max(30, (pol.speed / 3.6) * this.k);
      const wantRot = clamp(Math.atan2(pol.vx, fwd), -0.32, 0.32);
      pol.rot += (wantRot - pol.rot) * (1 - Math.exp(-10 * dt));
    }

    pol.y = this.baseY - (pol.z - this.pz) * this.k;
    const gap = this.pz - pol.z;

    // Siren audio modulation
    this.audio?.setPolice(Math.abs(gap), this.phase === "playing" || this.phase === "busted");

    if (this.phase === "playing") {
      // Escaped check
      if (gap >= ESCAPE_GAP) {
        this.phase = "escaped";
        this.gameOverOutcome = "escaped";
        this.audio?.setPolice(999, false);
      }
      // Busted: police blocked the road right in front of the Lamborghini
      else if (
        pol.blocking &&
        -gap > 0 &&
        -gap < this.lenM * 3 &&
        Math.abs(pol.x - this.player.x) < this.carW * 0.8
      ) {
        this.phase = "busted";
        this.gameOverOutcome = "busted";
        this.crashT = 0;
        this.audio?.setPolice(10, true);
      }
      // Fallback: rear contact still busts
      else if (!pol.blocking && isRearHit(gap, pol.x - this.player.x, this.lenM * 0.95, this.carW)) {
        this.phase = "busted";
        this.gameOverOutcome = "busted";
        this.crashT = 0;
        this.shake = 3;
        this.audio?.setPolice(10, true);
      }
    }
  }

  // ---------- Horn Yield Reaction ----------
  private triggerHornYield() {
    const p = this.player;
    const pLane = clamp(Math.floor((p.x - this.roadX) / this.laneW), 0, LANES - 1);

    for (const t of this.traffic) {
      if (t.hit) continue;
      const dz = t.z - this.pz;
      // Cars ahead of player (between 12m and 160m ahead)
      if (dz > 12 && dz < 160) {
        // Car is blocking the player's path or in player's lane
        const inPath = t.lane === pLane || Math.abs(t.x - p.x) < this.carW * 0.95;
        if (inPath && t.yieldState !== "changing") {
          t.originalCruise = t.originalCruise ?? t.cruise;

          // Find adjacent lanes away from player's current lane
          const candidates: number[] = [];
          if (t.lane > 0 && t.lane - 1 !== pLane) candidates.push(t.lane - 1);
          if (t.lane < LANES - 1 && t.lane + 1 !== pLane) candidates.push(t.lane + 1);

          if (candidates.length === 0) {
            if (t.lane > 0) choices_push_left: {
              candidates.push(t.lane - 1);
            }
            if (t.lane < LANES - 1) choices_push_right: {
              candidates.push(t.lane + 1);
            }
          }

          if (candidates.length === 0) continue;

          // Pick preferred target lane
          const target = candidates.find((l) => isLaneClear(this.traffic, t, l, 16, 14)) ?? candidates[0]!;
          t.targetLane = target;
          t.signal = target < t.lane ? -1 : 1;
          t.signalTimer = 0;

          // Check if target lane is clear beside this car
          const clear = isLaneClear(this.traffic, t, target, 16, 14);
          if (clear) {
            // Lane is immediately open: begin smooth lane change!
            t.yieldState = "changing";
          } else {
            // Adjacent lane is blocked by another car beside it!
            // Accelerate faster first to pass the blocking car, then change lane!
            t.yieldState = "accelerating";
          }
        }
      }
    }
  }

  // ---------- Traffic update & maneuvers ----------
  private updateTraffic(dt: number) {
    const byLane: TrafficCar[][] = [[], [], []];
    for (const t of this.traffic) byLane[t.lane]?.push(t);
    for (const lane of byLane) lane.sort((a, b) => b.z - a.z);

    const caps = wallSpeedCaps(this.traffic, this.spanM * WALL_LEN);
    const capOf = new Map(this.traffic.map((t, i) => [t, caps[i] ?? Infinity]));

    for (const lane of byLane) {
      for (let i = 0; i < lane.length; i++) {
        const t = lane[i]!;
        if (t.hit) {
          t.speed *= Math.exp(-1.4 * dt);
          t.rot += t.vr * dt;
          t.vr *= Math.exp(-2 * dt);
          t.x += t.vx * dt;
          t.vx *= Math.exp(-3 * dt);
        } else {
          // 1. Yield State Machine
          if (t.yieldState === "accelerating") {
            // Accelerate to overtake the car alongside it
            const targetSpeed = Math.min(220, (t.originalCruise ?? t.cruise) + 65);
            t.cruise += (targetSpeed - t.cruise) * (1 - Math.exp(-4.5 * dt));

            // Check if it has now cleared the car beside it
            if (isLaneClear(this.traffic, t, t.targetLane, 16, 14)) {
              t.yieldState = "changing";
            }

            // Stay steady in current lane while accelerating
            const curLaneX = this.laneX(t.lane);
            t.x += (curLaneX - t.x) * (1 - Math.exp(-10 * dt));
            t.rot = 0;
          } else if (t.yieldState === "changing") {
            // Smoothly steer towards target lane (NO TELEPORTATION)
            const targetX = this.laneX(t.targetLane);
            const dist = targetX - t.x;
            const dir = Math.sign(dist);

            // Never swerve into the player if player is alongside
            const dz = Math.abs(t.z - this.pz);
            const nearPlayer = dz < this.lenM * 1.5;
            const movingTowardsPlayer = nearPlayer && Math.sign(this.player.x - t.x) === dir;

            if (!movingTowardsPlayer) {
              const speedPx = this.laneW * 1.35; // smooth lateral velocity
              t.x += dir * Math.min(Math.abs(dist), speedPx * dt);
              t.rot = dir * 0.08;
            } else {
              t.rot = 0;
            }

            // Check arrival at target lane center
            if (Math.abs(targetX - t.x) < 1.5) {
              t.x = targetX;
              t.rot = 0;
              t.lane = t.targetLane;
              t.yieldState = "idle";
              t.signal = 0;
            }
          } else {
            // Idle state: restore normal cruise speed and stay in lane
            if (t.originalCruise !== undefined && Math.abs(t.cruise - t.originalCruise) > 1) {
              t.cruise += (t.originalCruise - t.cruise) * (1 - Math.exp(-2.5 * dt));
            }
            const curLaneX = this.laneX(t.lane);
            t.x += (curLaneX - t.x) * (1 - Math.exp(-12 * dt));
            t.rot = 0;
            t.signal = 0;
          }

          // 2. Anti-Collision and safe spacing (cars never enter inside each other)
          let desired = Math.min(t.cruise, capOf.get(t) ?? Infinity);
          const ahead = i > 0 ? (lane[i - 1] ?? null) : null;
          if (ahead) {
            const gap = ahead.z - t.z;
            const minGap = ((t.h + ahead.h) / 2 / this.k) * 1.35 + 2.5;
            if (gap < minGap * 1.7) {
              desired = Math.min(desired, ahead.speed * (gap < minGap ? 0.75 : 0.95));
            }
            // Strict physical clearance so cars never overlap or cross into each other
            if (gap < minGap) {
              t.z = ahead.z - minGap;
              t.speed = Math.min(t.speed, ahead.speed);
            }
          }

          // Speed update
          t.speed += (desired - t.speed) * (1 - Math.exp(-5 * dt));
        }

        t.z += (t.speed / 3.6) * dt;
        t.y = this.baseY - (t.z - this.pz) * this.k;
        t.signalTimer += dt;
      }
    }

    const behindLimit = this.threeD ? this.baseY + 40 * this.k : this.H + 260;
    const aheadLimit = this.threeD ? this.baseY - 230 * this.k : -this.H * 1.6;
    this.traffic = this.traffic.filter((t) => t.y < behindLimit && t.y > aheadLimit);
  }

  private spawn() {
    const aheadM = this.threeD ? 190 : (this.baseY + 260) / this.k;
    let guard = 0;
    while (this.nextSpawnZ < this.pz + aheadM && guard++ < 8) {
      this.trySpawn(this.nextSpawnZ);
      const L = this.spanM;
      const base = Math.max(L * 1.25, L * 3.4 - (this.distance / 700) * L);
      this.nextSpawnZ += base * rnd(0.75, 1.45);
    }
  }

  private trySpawn(z: number) {
    const blocked = blockedLanes(this.traffic, z, this.spanM * WALL_LEN);
    const free = [0, 1, 2].filter((l) => !blocked.has(l));
    if (free.length <= 1) return; // Keep at least one clear lane open!

    // Vehicle types palette
    const vehiclePool: { type: CarType; img: HTMLImageElement; minSpeed: number; maxSpeed: number; preferredLane?: number }[] = this.threeD ? [
      { type: "m5", img: this.images.m5, minSpeed: 110, maxSpeed: 170 },
      { type: "mustang-blue", img: this.images.mustangBlue, minSpeed: 100, maxSpeed: 160 },
      { type: "mustang-black", img: this.images.mustangBlack, minSpeed: 100, maxSpeed: 160 },
      { type: "jesko", img: this.images.m5, minSpeed: 160, maxSpeed: 215, preferredLane: 2 },
    ] : [
      { type: "sedan", img: this.images.sedan, minSpeed: 85, maxSpeed: 115 },
      { type: "hatch", img: this.images.hatch, minSpeed: 80, maxSpeed: 110 },
      { type: "pickup", img: this.images.pickup, minSpeed: 80, maxSpeed: 105 },
      { type: "suv", img: this.images.suv, minSpeed: 95, maxSpeed: 125 },
      { type: "bus", img: this.images.bus, minSpeed: 72, maxSpeed: 88, preferredLane: 0 },
      { type: "m5", img: this.images.m5, minSpeed: 140, maxSpeed: 195, preferredLane: 2 },
      { type: "mustang-blue", img: this.images.mustangBlue, minSpeed: 145, maxSpeed: 200, preferredLane: 2 },
      { type: "mustang-black", img: this.images.mustangBlack, minSpeed: 145, maxSpeed: 200, preferredLane: 2 },
    ];

    const pick = vehiclePool[Math.floor(Math.random() * vehiclePool.length)]!;
    let lane = free[Math.floor(Math.random() * free.length)] ?? 1;
    if (pick.preferredLane !== undefined && free.includes(pick.preferredLane)) {
      lane = pick.preferredLane;
    }

    const ppm = this.laneW / 3.6;
    const dims3d: Partial<Record<CarType, [number, number]>> = { m5: [1.95, 4.8], "mustang-blue": [1.92, 4.8], "mustang-black": [1.92, 4.8], jesko: [2.05, 4.6] };
    const d3 = this.threeD ? dims3d[pick.type] : undefined;
    const w = d3 ? d3[0] * ppm : pick.type === "bus" ? this.carW * 1.05 : this.carW * 0.94;
    const cruise = rnd(pick.minSpeed, pick.maxSpeed) + Math.min(25, this.distance / 400);

    this.traffic.push({
      x: this.laneX(lane),
      y: -220,
      z,
      w,
      h: d3 ? d3[1] * ppm : w * (pick.img.naturalHeight / pick.img.naturalWidth),
      lane,
      targetLane: lane,
      speed: cruise,
      cruise,
      img: pick.img,
      type: pick.type,
      hit: false,
      rot: 0,
      vr: 0,
      vx: 0,
      signal: 0,
      signalTimer: 0,
      yieldState: "idle",
      originalCruise: cruise,
    });
  }

  private checkCollision() {
    const p = this.player;
    const pw = p.w * 0.38;
    const ph = p.h * 0.45;
    for (const t of this.traffic) {
      const tw = t.w * 0.39;
      const th = t.h * 0.45;
      if (Math.abs(t.x - p.x) < pw + tw && Math.abs(t.y - this.baseY) < ph + th) {
        this.crash(t);
        return;
      }
    }
  }

  private crash(t: TrafficCar) {
    const p = this.player;
    this.phase = "crashed";
    this.gameOverOutcome = "crash";
    this.crashT = 0;
    this.emitT = 0;
    const side = p.x < t.x ? -1 : 1;
    const severity = clamp(Math.abs(p.speed - t.speed) / 150, 0.4, 1.6);
    p.spin = side * rnd(2.5, 4) * severity;
    p.vx = side * 140 * severity;
    p.speed = Math.max(t.speed * 0.6, p.speed * 0.35);
    t.hit = true;
    t.vr = -side * rnd(1.5, 3) * severity;
    t.vx = -side * 90 * severity;
    t.speed = Math.max(t.speed, p.speed);
    this.shake = 16 * severity;
    this.flash = 0.8;

    const cx = (p.x + t.x) / 2;
    const cy = (this.baseY + t.y) / 2;
    this.emitSparks(cx, cy, 26, 0);
    for (let i = 0; i < 18; i++) {
      this.particles.push({
        kind: "debris",
        x: cx,
        y: cy,
        vx: rnd(-220, 220),
        vy: rnd(-220, 220),
        life: 0,
        max: rnd(0.8, 1.6),
        size: rnd(3, 7),
        grow: 0,
        alpha: 1,
        rot: rnd(0, 6),
        dark: Math.random() < 0.7,
      });
    }
    for (let i = 0; i < 14; i++) this.emitSmoke(cx + rnd(-20, 20), cy + rnd(-20, 20), false);
    this.audio?.crash();
  }

  // ---------- Particles & Exhaust Flames ----------
  private emitExhaustParticles() {
    const p = this.player;
    const rearY = this.baseY + p.h * 0.44;
    // Dual exhaust tips situated high in the center of Revuelto
    for (const sx of [-1, 1]) {
      const ex = p.x + sx * p.w * 0.12;
      this.particles.push({
        kind: "flame",
        x: ex + rnd(-2, 2),
        y: rearY,
        vx: rnd(-10, 10),
        vy: rnd(140, 260) + p.speed * 0.5,
        life: 0,
        max: rnd(0.16, 0.26),
        size: rnd(10, 18),
        grow: rnd(15, 30),
        alpha: 1,
        rot: rnd(0, Math.PI * 2),
      });
    }
  }

  private emitSmoke(x: number, y: number, dark: boolean) {
    if (this.particles.length > 520) return;
    this.particles.push({
      kind: "smoke",
      x: x + rnd(-6, 6),
      y: y + rnd(-6, 6),
      vx: rnd(-18, 18),
      vy: rnd(-30, 6),
      life: 0,
      max: rnd(1.6, 2.8),
      size: rnd(18, 28),
      grow: rnd(40, 64),
      alpha: rnd(0.5, 0.8),
      rot: 0,
      dark,
    });
  }

  private emitSparks(x: number, y: number, n: number, side: number) {
    for (let i = 0; i < n; i++) {
      const dir = side === 0 ? rnd(0, Math.PI * 2) : side < 0 ? rnd(Math.PI * 0.6, Math.PI * 1.4) : rnd(-0.4 * Math.PI, 0.4 * Math.PI);
      const sp = rnd(160, 420);
      this.particles.push({
        kind: "spark",
        x,
        y,
        vx: Math.cos(dir) * sp,
        vy: Math.sin(dir) * sp + (side !== 0 ? 120 : 0),
        life: 0,
        max: rnd(0.25, 0.55),
        size: 1.6,
        grow: 0,
        alpha: 1,
        rot: 0,
      });
    }
  }

  private updateParticles(dt: number, dsPx: number) {
    for (const q of this.particles) {
      q.life += dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt + dsPx;
      if (q.kind === "smoke") {
        q.size += q.grow * dt;
        q.vx *= Math.exp(-0.8 * dt);
        q.vy *= Math.exp(-0.8 * dt);
      } else if (q.kind === "flame" || q.kind === "spray") {
        q.size += q.grow * dt;
        q.vx *= Math.exp(-2.5 * dt);
        q.vy *= Math.exp(-2.0 * dt);
      } else if (q.kind === "debris") {
        q.vx *= Math.exp(-3 * dt);
        q.vy *= Math.exp(-3 * dt);
        q.rot += dt * 8;
      } else {
        q.vx *= Math.exp(-4 * dt);
        q.vy *= Math.exp(-4 * dt);
      }
    }
    this.particles = this.particles.filter((q) => q.life < q.max && q.y < this.H + 120);
  }

  // ---------- rendering ----------
  private render() {
    const g = this.ctx;
    const { W, H, pz } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const tunnel = inTunnel(pz);
    const night = nightAmount(pz);
    const headlightsOn = lightsOn(pz);

    // Base background color dynamically blended based on tunnel / time of day
    if (tunnel) {
      g.fillStyle = "#161719"; // dark enclosed tunnel floor
    } else {
      // blend day grass into dark midnight grass
      const r = Math.round(65 * (1 - night) + 12 * night);
      const gC = Math.round(98 * (1 - night) + 18 * night);
      const b = Math.round(43 * (1 - night) + 22 * night);
      g.fillStyle = `rgb(${r},${gC},${b})`;
    }
    g.fillRect(0, 0, W, H);

    g.save();
    if (this.shake > 0.3) g.translate(rnd(-1, 1) * this.shake, rnd(-1, 1) * this.shake);

    // Render road tiles
    if (this.tileDay) {
      for (let y = this.scroll - TILE_H; y < H; y += TILE_H) {
        g.drawImage(this.tileDay, 0, y, W, TILE_H);
      }
    }

    // Overhead tunnel or scenery elements
    this.renderSceneryOverlays(g, pz, tunnel, night);

    const p = this.player;
    const rain = rainAmount(pz);

    // Wet asphalt gloss & dynamic raindrops
    if (rain > 0.05) {
      g.fillStyle = `rgba(10, 14, 22, ${rain * 0.45})`;
      g.fillRect(this.roadX, 0, this.roadW, H);

      // Taillight wet reflections on glossy asphalt
      g.save();
      g.globalCompositeOperation = "lighter";
      for (const t of this.traffic) {
        if (t.y > -80 && t.y < H + 60) {
          const reflectGrad = g.createLinearGradient(t.x, t.y + t.h * 0.4, t.x, t.y + t.h * 0.4 + 90);
          reflectGrad.addColorStop(0, `rgba(255, 45, 30, ${rain * 0.35})`);
          reflectGrad.addColorStop(1, "rgba(255, 45, 30, 0)");
          g.fillStyle = reflectGrad;
          g.fillRect(t.x - t.w * 0.35, t.y + t.h * 0.4, t.w * 0.7, 90);
        }
      }
      g.restore();

      // Dynamic angled rain streaks
      g.strokeStyle = `rgba(215, 235, 255, ${rain * 0.4})`;
      g.lineWidth = 1.2;
      g.beginPath();
      const rainDropSpeed = 1400 + p.speed * 5;
      for (let i = 0; i < 36; i++) {
        const rx = ((i * 73 + Date.now() * 0.35) % (W + 60)) - 30;
        const ry = ((i * 127 + Date.now() * (rainDropSpeed * 0.001)) % (H + 100)) - 50;
        const rLen = rnd(22, 42);
        g.moveTo(rx, ry);
        g.lineTo(rx - 3, ry + rLen);
      }
      g.stroke();
    }

    // Streaks at high speed
    const streakA = clamp((p.speed - 170) / 170, 0, 1) * 0.28;
    if (streakA > 0.01) {
      g.strokeStyle = `rgba(255,255,255,${streakA})`;
      g.lineWidth = 1.2;
      g.beginPath();
      for (const s of this.streaks) {
        g.moveTo(s.x, s.y);
        g.lineTo(s.x, s.y + s.len);
      }
      g.stroke();
    }

    // Draw Headlight Beams (Before cars so cars draw over the asphalt light)
    const isHighBeam = this.highBeamTimer > 0;
    if (headlightsOn || isHighBeam) {
      // Traffic headlights
      for (const t of this.traffic) {
        if (!t.hit && t.y > -150 && t.y < H + 50) {
          this.drawHeadlights(g, t.x, t.y, t.w, t.h, t.rot, 0.45);
        }
      }
      // Police headlights
      if (this.mode === "police" && this.police.y > -200 && this.police.y < H + 100) {
        this.drawHeadlights(g, this.police.x, this.police.y, this.police.w, this.police.h, 0, 0.6);
      }
      // Player headlights (Twin projectors with high beam flash)
      const pIntensity = isHighBeam ? 1.45 : 0.85;
      this.drawHeadlights(g, p.x, this.baseY, p.w, p.h, p.rot, pIntensity, isHighBeam);
    }

    // Draw Traffic Cars
    for (const t of this.traffic) {
      this.drawCar(t.img, t.x, t.y, t.w, t.h, t.rot, false, t.signal, t.signalTimer, headlightsOn);
    }

    // Draw Police Porsche (if on screen)
    if (this.mode === "police" && this.police.y > -220 && this.police.y < H + 150) {
      this.drawPoliceCar(g, this.police.x, this.police.y, this.police.w, this.police.h, headlightsOn);
    }

    // Draw Player Car
    this.drawCar(
      this.images.player,
      p.x,
      this.baseY,
      p.w,
      p.h,
      p.rot,
      this.input.brake && this.phase === "playing",
      0,
      0,
      headlightsOn,
    );

    // Draw Exhaust Flame Jets (Requirement 1)
    if (this.exhaustFlameTimer > 0) {
      this.drawExhaustFlame(g, p.x, this.baseY, p.w, p.h, p.rot);
    }

    // Particles (Smoke, Sparks, Debris, Flame)
    this.renderParticles(g);

    // Highway Bridges and Overhead Sign Gantries
    this.renderBridgesAndGantries(g, pz);

    g.restore();

    // Night and Tunnel ambient darkness overlay
    if (tunnel) {
      // Subtle top/bottom dark tunnel vignette
      const tvGrad = g.createLinearGradient(0, 0, 0, H);
      tvGrad.addColorStop(0, "rgba(8,10,14,0.6)");
      tvGrad.addColorStop(0.3, "rgba(8,10,14,0.3)");
      tvGrad.addColorStop(0.7, "rgba(8,10,14,0.3)");
      tvGrad.addColorStop(1, "rgba(8,10,14,0.5)");
      g.fillStyle = tvGrad;
      g.fillRect(0, 0, W, H);
    } else if (night > 0.05) {
      g.fillStyle = `rgba(5, 8, 18, ${night * 0.58})`;
      g.fillRect(0, 0, W, H);
    }

    // Danger flashing vignette when police is in red zone (<50m)
    if (this.mode === "police" && this.phase === "playing") {
      const gap = pz - this.police.z;
      if (gap < 50) {
        const flashIntensity = (1 - gap / 50) * 0.35 * (Math.sin(Date.now() * 0.012) * 0.5 + 0.5);
        g.fillStyle = `rgba(220, 20, 20, ${flashIntensity})`;
        g.fillRect(0, 0, W, H);
      }
    }

    if (this.flash > 0.02) {
      g.fillStyle = `rgba(255,240,220,${this.flash * 0.6})`;
      g.fillRect(0, 0, W, H);
    }
  }

  // ---------- Scenery Overlays (Tunnel ceiling, street lights, roadside signs) ----------
  private renderSceneryOverlays(g: CanvasRenderingContext2D, pz: number, tunnel: boolean, night: number) {
    const { W, H, roadX, roadW } = this;
    if (tunnel) {
      // Dark tunnel ceiling with overhead fluorescent tube lights that scroll by
      g.fillStyle = "rgba(18, 20, 24, 0.4)";
      g.fillRect(roadX, 0, roadW, H);

      // Tunnel fluorescent light strips
      const lightSpacing = 90;
      const offY = (this.scroll * 1.0) % lightSpacing;
      g.fillStyle = "rgba(255, 245, 200, 0.85)";
      g.shadowColor = "rgba(255, 230, 160, 0.8)";
      g.shadowBlur = 10;
      for (let y = offY - lightSpacing; y < H; y += lightSpacing) {
        // Central tunnel ceiling light
        g.fillRect(roadX + roadW * 0.5 - 18, y, 36, 4);
      }
      g.shadowBlur = 0;
    } else if (night > 0.3) {
      // Highway light poles with light pools on asphalt
      const poleSpacing = 280;
      const offY = (this.scroll * 1.0) % poleSpacing;
      for (let y = offY - poleSpacing; y < H + 100; y += poleSpacing) {
        // Light pool
        const grad = g.createRadialGradient(roadX + roadW * 0.7, y, 10, roadX + roadW * 0.7, y, 110);
        grad.addColorStop(0, `rgba(255, 225, 140, ${night * 0.35})`);
        grad.addColorStop(1, "rgba(255, 225, 140, 0)");
        g.fillStyle = grad;
        g.fillRect(roadX, y - 110, roadW, 220);

        // Streetlight pole arm
        g.fillStyle = "#8a8f98";
        g.fillRect(roadX + roadW + 6, y - 6, 4, 12);
      }
    }
  }

  // ---------- Highway Bridges and Overhead Sign Gantries (Requirement 14) ----------
  private renderBridgesAndGantries(g: CanvasRenderingContext2D, pz: number) {
    const { roadX, roadW, H } = this;

    // Overhead Sign Gantries
    for (const sz of SIGN_GANTRIES) {
      const sy = this.baseY - (sz - pz) * this.k;
      if (sy > -80 && sy < H + 60) {
        // Steel frame truss
        g.fillStyle = "#3a3e46";
        g.fillRect(roadX - 16, sy, roadW + 32, 10);
        g.fillStyle = "#1e2025";
        g.fillRect(roadX - 18, sy - 4, 6, 18);
        g.fillRect(roadX + roadW + 12, sy - 4, 6, 18);

        // Green highway signs
        g.fillStyle = "#115c2a"; // Brazilian highway sign green
        g.strokeStyle = "#ffffff";
        g.lineWidth = 1.2;
        g.fillRect(roadX + 20, sy - 28, roadW * 0.42, 26);
        g.strokeRect(roadX + 20, sy - 28, roadW * 0.42, 26);

        g.fillStyle = "#ffffff";
        g.font = "bold 9px Barlow, sans-serif";
        g.fillText("RODOVIA REVUELTO", roadX + 26, sy - 16);
        g.font = "8px Barlow, sans-serif";
        g.fillText("SAÍDA 1 - CAPITAL 120 KM/H", roadX + 26, sy - 6);

        // Shadow below gantry
        g.fillStyle = "rgba(0,0,0,0.22)";
        g.fillRect(roadX, sy + 10, roadW, 14);
      }
    }

    // Overpass Bridges
    for (const [bz0, bz1] of BRIDGES) {
      const by0 = this.baseY - (bz1 - pz) * this.k;
      const by1 = this.baseY - (bz0 - pz) * this.k;
      if (by1 > -120 && by0 < H + 120) {
        const bridgeH = Math.max(45, by1 - by0);
        // Shadow cast on the highway underneath
        g.fillStyle = "rgba(0,0,0,0.4)";
        g.fillRect(roadX, by0, roadW, bridgeH);

        // Concrete overpass bridge deck
        g.fillStyle = "#5c6068";
        g.fillRect(roadX - 22, by0 - 8, roadW + 44, bridgeH * 0.4);
        g.fillStyle = "#797e88";
        g.fillRect(roadX - 22, by0, roadW + 44, bridgeH * 0.3);
        // Concrete railing
        g.fillStyle = "#a2a8b2";
        g.fillRect(roadX - 22, by0 - 12, roadW + 44, 4);
      }
    }

    // Speed Trap Radar Gantries
    for (const rz of SPEED_RADARS) {
      const ry = this.baseY - (rz - pz) * this.k;
      if (ry > -90 && ry < H + 60) {
        // Metallic overhead truss
        g.fillStyle = "#2c2f36";
        g.fillRect(roadX - 16, ry, roadW + 32, 8);
        g.fillStyle = "#1e2025";
        g.fillRect(roadX - 18, ry - 3, 5, 14);
        g.fillRect(roadX + roadW + 13, ry - 3, 5, 14);

        // Radar speed cameras above each lane
        for (let l = 0; l < LANES; l++) {
          const cx = this.laneX(l);
          g.fillStyle = "#181a20";
          g.fillRect(cx - 11, ry - 14, 22, 14);
          // Optical camera lens
          g.fillStyle = "#0c0d10";
          g.beginPath();
          g.arc(cx, ry - 7, 4.5, 0, Math.PI * 2);
          g.fill();
          // Radar LED indicator
          g.fillStyle = Math.floor(Date.now() / 350) % 2 === 0 ? "#00c8ff" : "#005588";
          g.fillRect(cx - 8, ry - 12, 3, 3);
        }

        // Circular speed limit 120 sign on left side of gantry
        const sx = roadX + 28;
        const sy = ry - 16;
        g.fillStyle = "#ffffff";
        g.beginPath();
        g.arc(sx, sy, 14, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = "#dd1111";
        g.lineWidth = 2.8;
        g.stroke();
        g.fillStyle = "#111111";
        g.font = "bold 11px Barlow, sans-serif";
        g.textAlign = "center";
        g.fillText("120", sx, sy + 4);
        g.textAlign = "start";

        // Radar notice sign on right side
        g.fillStyle = "#0b4f8c";
        g.fillRect(roadX + roadW - 74, ry - 22, 60, 20);
        g.strokeStyle = "#ffffff";
        g.lineWidth = 1;
        g.strokeRect(roadX + roadW - 74, ry - 22, 60, 20);
        g.fillStyle = "#ffffff";
        g.font = "bold 8px Barlow, sans-serif";
        g.fillText("RADAR FIXO", roadX + roadW - 68, ry - 12);
        g.fillText("120 KM/H", roadX + roadW - 63, ry - 4);
      }
    }
  }

  // ---------- Headlight Beams ----------
  private drawHeadlights(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rot: number, intensity: number, isHighBeam = false) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.globalCompositeOperation = "lighter";

    const beamLen = isHighBeam ? 360 : 220;
    const spread = isHighBeam ? 0.95 : 0.65;
    for (const sx of [-1, 1]) {
      const hx = sx * w * 0.32;
      const hy = -h * 0.44;

      const grad = g.createRadialGradient(hx, hy, 4, hx, hy - beamLen * 0.7, beamLen);
      grad.addColorStop(0, `rgba(240, 248, 255, ${0.65 * intensity})`);
      grad.addColorStop(0.3, `rgba(220, 240, 255, ${0.35 * intensity})`);
      grad.addColorStop(1, "rgba(200, 225, 255, 0)");

      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(hx - 6, hy);
      g.lineTo(hx - w * spread, hy - beamLen);
      g.lineTo(hx + w * spread, hy - beamLen);
      g.lineTo(hx + 6, hy);
      g.closePath();
      g.fill();
    }

    g.globalCompositeOperation = "source-over";
    g.restore();
  }

  // ---------- Exhaust Flame Drawing (Requirement 1) ----------
  private drawExhaustFlame(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rot: number) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.globalCompositeOperation = "lighter";

    const t = this.exhaustFlameTimer / 0.28;
    const flameLen = (28 + Math.random() * 16) * t;

    // Revuelto dual central exhaust tips
    for (const sx of [-1, 1]) {
      const ex = sx * w * 0.12;
      const ey = h * 0.46;

      // Outer orange flame cone
      const gradOrange = g.createLinearGradient(ex, ey, ex, ey + flameLen);
      gradOrange.addColorStop(0, "rgba(255, 140, 20, 0.95)");
      gradOrange.addColorStop(0.5, "rgba(255, 70, 0, 0.8)");
      gradOrange.addColorStop(1, "rgba(255, 0, 0, 0)");

      g.fillStyle = gradOrange;
      g.beginPath();
      g.moveTo(ex - 7, ey);
      g.lineTo(ex, ey + flameLen);
      g.lineTo(ex + 7, ey);
      g.closePath();
      g.fill();

      // Inner cyan/blue plasma core (modern hybrid V12 backfire!)
      const gradCyan = g.createLinearGradient(ex, ey, ex, ey + flameLen * 0.55);
      gradCyan.addColorStop(0, "rgba(200, 250, 255, 1)");
      gradCyan.addColorStop(0.4, "rgba(40, 180, 255, 0.85)");
      gradCyan.addColorStop(1, "rgba(0, 100, 255, 0)");

      g.fillStyle = gradCyan;
      g.beginPath();
      g.moveTo(ex - 4, ey);
      g.lineTo(ex, ey + flameLen * 0.55);
      g.lineTo(ex + 4, ey);
      g.closePath();
      g.fill();
    }

    g.globalCompositeOperation = "source-over";
    g.restore();
  }

  // ---------- Car Drawing with Turn Signals ("Seta") and Taillights ----------
  private drawCar(
    img: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number,
    rot: number,
    braking: boolean,
    signal: -1 | 1 | 0 = 0,
    signalTimer = 0,
    headlightsOn = false,
  ) {
    const g = this.ctx;
    g.save();
    g.translate(x, y);
    g.rotate(rot);

    // Shadow
    g.globalAlpha = 0.5;
    g.drawImage(this.shadow, -w / 2 + 5, -h / 2 + 8, w, h * 1.04);
    g.globalAlpha = 1;

    // Sprite
    g.drawImage(img, -w / 2, -h / 2, w, h);

    // Taillights at night or when braking
    if (braking || headlightsOn) {
      g.globalCompositeOperation = "lighter";
      const glowR = braking ? w * 0.32 : w * 0.18;
      const alpha = braking ? 0.9 : 0.65;
      for (const sx of [-1, 1]) {
        const cx = sx * w * 0.32;
        const cy = h * 0.44;
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        grad.addColorStop(0, `rgba(255, 30, 20, ${alpha})`);
        grad.addColorStop(1, "rgba(255, 0, 0, 0)");
        g.fillStyle = grad;
        g.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
      }
      g.globalCompositeOperation = "source-over";
    }

    // Turn Signals ("Seta" blinking orange light)
    if (signal !== 0) {
      const isBlinkOn = Math.floor(signalTimer * 4.5) % 2 === 0;
      if (isBlinkOn) {
        g.globalCompositeOperation = "lighter";
        const sx = signal; // -1 for left, 1 for right
        const bx = sx * w * 0.38;
        const by = h * 0.43;

        const grad = g.createRadialGradient(bx, by, 1, bx, by, w * 0.28);
        grad.addColorStop(0, "rgba(255, 175, 0, 1)");
        grad.addColorStop(0.4, "rgba(255, 130, 0, 0.7)");
        grad.addColorStop(1, "rgba(255, 100, 0, 0)");
        g.fillStyle = grad;
        g.fillRect(bx - w * 0.28, by - w * 0.28, w * 0.56, w * 0.56);

        // Small indicator bulb on front corner as well
        const fx = sx * w * 0.38;
        const fy = -h * 0.42;
        const gradFront = g.createRadialGradient(fx, fy, 1, fx, fy, w * 0.2);
        gradFront.addColorStop(0, "rgba(255, 175, 0, 0.9)");
        gradFront.addColorStop(1, "rgba(255, 120, 0, 0)");
        g.fillStyle = gradFront;
        g.fillRect(fx - w * 0.2, fy - w * 0.2, w * 0.4, w * 0.4);

        g.globalCompositeOperation = "source-over";
      }
    }

    g.restore();
  }

  // ---------- Police GT3 RS Porsche with Flashing Lightbar ----------
  private drawPoliceCar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, headlightsOn: boolean) {
    g.save();
    g.translate(x, y);
    g.rotate(this.police.rot);

    // Shadow
    g.globalAlpha = 0.55;
    g.drawImage(this.shadow, -w / 2 + 5, -h / 2 + 8, w, h * 1.04);
    g.globalAlpha = 1;

    // Porsche GT3 RS police sprite
    g.drawImage(this.images.police, -w / 2, -h / 2, w, h);

    // Flashing Blue and Red Emergency Lightbar on roof
    g.globalCompositeOperation = "lighter";
    const flashStep = Math.floor(Date.now() / 90) % 4;
    const blueOn = flashStep === 0 || flashStep === 1;
    const redOn = flashStep === 2 || flashStep === 3;

    // Roof lightbar positions
    const ly = -h * 0.05;

    // Blue strobe (Left)
    if (blueOn) {
      const lx = -w * 0.2;
      const gradB = g.createRadialGradient(lx, ly, 2, lx, ly, w * 0.45);
      gradB.addColorStop(0, "rgba(50, 140, 255, 1)");
      gradB.addColorStop(0.35, "rgba(20, 90, 255, 0.75)");
      gradB.addColorStop(1, "rgba(0, 50, 255, 0)");
      g.fillStyle = gradB;
      g.fillRect(lx - w * 0.45, ly - w * 0.45, w * 0.9, w * 0.9);
    }

    // Red strobe (Right)
    if (redOn) {
      const rx = w * 0.2;
      const gradR = g.createRadialGradient(rx, ly, 2, rx, ly, w * 0.45);
      gradR.addColorStop(0, "rgba(255, 50, 40, 1)");
      gradR.addColorStop(0.35, "rgba(255, 20, 20, 0.75)");
      gradR.addColorStop(1, "rgba(255, 0, 0, 0)");
      g.fillStyle = gradR;
      g.fillRect(rx - w * 0.45, ly - w * 0.45, w * 0.9, w * 0.9);
    }

    g.globalCompositeOperation = "source-over";
    g.restore();
  }

  // ---------- Particles Render ----------
  private renderParticles(g: CanvasRenderingContext2D) {
    for (const q of this.particles) {
      const t = q.life / q.max;
      if (q.kind === "smoke") {
        const a = q.alpha * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
        g.globalAlpha = Math.max(0, a);
        const s = q.size * 2;
        g.drawImage(q.dark ? this.smokeDark : this.smokeLight, q.x - s / 2, q.y - s / 2, s, s);
      } else if (q.kind === "flame") {
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = Math.max(0, 1 - t);
        const grad = g.createRadialGradient(q.x, q.y, 1, q.x, q.y, q.size);
        grad.addColorStop(0, "rgba(255, 200, 100, 0.9)");
        grad.addColorStop(0.4, "rgba(255, 80, 20, 0.7)");
        grad.addColorStop(1, "rgba(255, 0, 0, 0)");
        g.fillStyle = grad;
        g.fillRect(q.x - q.size, q.y - q.size, q.size * 2, q.size * 2);
        g.globalCompositeOperation = "source-over";
      } else if (q.kind === "spray") {
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = Math.max(0, q.alpha * (1 - t));
        const grad = g.createRadialGradient(q.x, q.y, 1, q.x, q.y, q.size);
        grad.addColorStop(0, "rgba(225, 240, 255, 0.65)");
        grad.addColorStop(0.5, "rgba(180, 215, 245, 0.35)");
        grad.addColorStop(1, "rgba(150, 190, 230, 0)");
        g.fillStyle = grad;
        g.fillRect(q.x - q.size, q.y - q.size, q.size * 2, q.size * 2);
        g.globalCompositeOperation = "source-over";
      } else if (q.kind === "debris") {
        g.globalAlpha = 1 - t;
        g.save();
        g.translate(q.x, q.y);
        g.rotate(q.rot);
        g.fillStyle = q.dark ? "#141416" : "#b9bec4";
        g.fillRect(-q.size / 2, -q.size / 3, q.size, q.size * 0.66);
        g.restore();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = "lighter";
    g.lineCap = "round";
    for (const q of this.particles) {
      if (q.kind !== "spark") continue;
      const t = q.life / q.max;
      g.strokeStyle = `rgba(255,${Math.round(200 - t * 120)},80,${1 - t})`;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(q.x, q.y);
      g.lineTo(q.x - q.vx * 0.03, q.y - q.vy * 0.03);
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";
  }

  private makeShadow() {
    const c = document.createElement("canvas");
    c.width = 100;
    c.height = 200;
    const g = c.getContext("2d")!;
    g.shadowColor = "rgba(0,0,0,1)";
    g.shadowBlur = 12;
    g.shadowOffsetX = 1000;
    g.fillStyle = "#000";
    roundRect(g, 18 - 1000, 12, 64, 176, 20);
    g.fill();
    return c;
  }

  private makeSmoke(r: number, gC: number, b: number) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${r},${gC},${b},1)`);
    grad.addColorStop(0.45, `rgba(${r},${gC},${b},0.8)`);
    grad.addColorStop(0.75, `rgba(${r},${gC},${b},0.35)`);
    grad.addColorStop(1, `rgba(${r},${gC},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  private buildTile() {
    const { W, dpr, roadX, roadW, laneW } = this;
    const c = document.createElement("canvas");
    c.width = Math.ceil(W * dpr);
    c.height = Math.ceil(TILE_H * dpr);
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);

    // grass verge
    g.fillStyle = C.grass;
    g.fillRect(0, 0, W, TILE_H);
    for (let i = 0; i < 1600; i++) {
      g.fillStyle = Math.random() < 0.5 ? C.grassDark : C.grassLight;
      g.globalAlpha = rnd(0.3, 0.8);
      g.fillRect(rnd(0, W), rnd(0, TILE_H), rnd(1, 3), rnd(2, 6));
    }
    g.globalAlpha = 1;

    // trees and bushes on both verges
    const sideW = roadX - 16;
    if (sideW > 18) {
      for (const side of [0, 1]) {
        for (let i = 0; i < 8; i++) {
          const r = rnd(9, Math.min(22, sideW * 0.45));
          const x = side === 0 ? rnd(r * 0.3, sideW - r) : W - rnd(r * 0.3, sideW - r);
          const y = rnd(0, TILE_H);
          for (const oy of [-TILE_H, 0, TILE_H]) this.drawTree(g, x, y + oy, r);
        }
      }
    }

    // gravel shoulders + guard rails with reflective studs
    g.fillStyle = C.gravel;
    g.fillRect(roadX - 14, 0, 14, TILE_H);
    g.fillRect(roadX + roadW, 0, 14, TILE_H);
    for (const rx of [roadX - 11, roadX + roadW + 6]) {
      g.fillStyle = C.railShadow;
      g.fillRect(rx + 3, 0, 5, TILE_H);
      for (let y = 0; y < TILE_H; y += 36) {
        g.fillStyle = C.post;
        g.fillRect(rx, y, 5, 6);
        // Reflector stud on guard post
        g.fillStyle = rx < roadX ? "#ffcc00" : "#ff3322";
        g.fillRect(rx + 1, y + 1, 2, 3);
      }
      g.fillStyle = C.rail;
      g.fillRect(rx + 1, 0, 3, TILE_H);
    }

    // asphalt
    g.fillStyle = C.asphalt;
    g.fillRect(roadX, 0, roadW, TILE_H);
    for (let i = 0; i < 3200; i++) {
      g.fillStyle = Math.random() < 0.5 ? C.asphaltLight : C.asphaltDark;
      g.globalAlpha = rnd(0.25, 0.7);
      g.fillRect(rnd(roadX, roadX + roadW), rnd(0, TILE_H), rnd(1, 2.2), rnd(1, 2.2));
    }
    // tyre wear
    g.globalAlpha = 0.09;
    g.fillStyle = "#000";
    for (let l = 0; l < LANES; l++) {
      const cx = roadX + laneW * (l + 0.5);
      g.fillRect(cx - laneW * 0.27 - 6, 0, 12, TILE_H);
      g.fillRect(cx + laneW * 0.27 - 6, 0, 12, TILE_H);
    }
    g.globalAlpha = 1;

    // white border markings
    g.fillStyle = C.line;
    g.fillRect(roadX + 6, 0, 3, TILE_H);
    g.fillRect(roadX + roadW - 9, 0, 3, TILE_H);

    // dashed lane dividers with reflective cat-eye studs
    for (let l = 1; l < LANES; l++) {
      const x = roadX + laneW * l - 1.5;
      for (let y = 0; y < TILE_H; y += DASH_P) {
        g.fillStyle = C.line;
        g.fillRect(x, y, 3, 40);
        // Cat-eye reflective stud
        g.fillStyle = "rgba(255, 255, 255, 0.9)";
        g.fillRect(x - 0.5, y + 44, 4, 3);
      }
    }
    this.tileDay = c;
  }

  private drawTree(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.beginPath();
    g.arc(x + r * 0.35, y + r * 0.45, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.tree;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.treeLight;
    g.beginPath();
    g.arc(x - r * 0.25, y - r * 0.25, r * 0.6, 0, Math.PI * 2);
    g.fill();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
