// Traffic rules that keep the road passable and handle realistic maneuvers.

export type CarType = "bus" | "suv" | "sedan" | "hatch" | "pickup" | "m5" | "mustang-blue" | "mustang-black";

export type YieldState = "idle" | "accelerating" | "changing";

export type LaneCar = {
  lane: number;
  z: number;
  speed: number;
  hit?: boolean;
  type?: CarType;
  signal?: -1 | 1 | 0; // -1 = left blinker, 1 = right blinker, 0 = off
  targetLane?: number;
  yieldState?: YieldState;
  originalCruise?: number;
};

/**
 * Speed cap (km/h) for each car so that cars never line up across every lane.
 * When one car has cars in all the other lanes close ahead of it, it is the
 * "rear" of a possible wall and must stay slower than them, so the wall never
 * closes and there is always a way through. Infinity = no cap.
 */
export function wallSpeedCaps(cars: LaneCar[], wallLen: number, lanes = 3): number[] {
  const caps = cars.map(() => Infinity);
  const lookAhead = wallLen * 2.5;
  for (let i = 0; i < cars.length; i++) {
    const me = cars[i]!;
    if (me.hit) continue;
    const group: LaneCar[] = [];
    let complete = true;
    for (let lane = 0; lane < lanes; lane++) {
      if (lane === me.lane) continue;
      let best: LaneCar | null = null;
      for (const o of cars) {
        if (o === me || o.hit || o.lane !== lane) continue;
        const dz = o.z - me.z;
        if (dz < 0 || dz > lookAhead) continue;
        if (!best || o.z < best.z) best = o;
      }
      if (!best) {
        complete = false;
        break;
      }
      group.push(best);
    }
    if (!complete || group.length === 0) continue;
    // `me` is the rearmost car of a possible wall (others are all ahead of it).
    const front = Math.max(...group.map((c) => c.z));
    const slowest = Math.min(...group.map((c) => c.speed));
    const span = front - me.z;
    caps[i] = Math.max(25, slowest - (span < wallLen ? 30 : 10));
  }
  return caps;
}

/** Lanes that are blocked by a car inside the window [z - win, z + win]. */
export function blockedLanes(cars: LaneCar[], z: number, win: number): Set<number> {
  return new Set(cars.filter((c) => !c.hit && Math.abs(c.z - z) < win).map((c) => c.lane));
}

/**
 * Check if a target lane has clear room ahead and behind `me`.
 */
export function isLaneClear(
  cars: LaneCar[],
  me: LaneCar,
  targetLane: number,
  gapAhead = 16,
  gapBehind = 14,
): boolean {
  for (const c of cars) {
    if (c === me || c.hit) continue;
    if (c.lane === targetLane || c.targetLane === targetLane) {
      const dz = c.z - me.z;
      if (dz >= 0 && dz < gapAhead) return false;
      if (dz < 0 && -dz < gapBehind) return false;
    }
  }
  return true;
}

/**
 * Can `me` move into lane `to` right now? The target lane needs room ahead and
 * behind, and after the move there must still be one lane free around it.
 */
export function laneChangeOk(
  cars: LaneCar[],
  me: LaneCar,
  to: number,
  o: { gapAhead: number; gapBehind: number; wallLen: number; lanes?: number },
): boolean {
  const lanes = o.lanes ?? 3;
  if (to < 0 || to >= lanes || to === me.lane) return false;
  for (const c of cars) {
    if (c === me || c.hit || c.lane !== to) continue;
    const dz = c.z - me.z;
    if (dz >= 0 && dz < o.gapAhead) return false;
    if (dz < 0 && -dz < o.gapBehind + Math.max(0, c.speed - me.speed) * 0.25) return false;
  }
  const after = cars.filter((c) => c !== me).concat([{ ...me, lane: to }]);
  return blockedLanes(after, me.z, o.wallLen).size < lanes;
}
