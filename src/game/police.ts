// Police Escape rules (pure, unit-tested). Gap = how far (HUD meters) the
// police Porsche is behind the Lamborghini.

/** The police starts this far behind, in the green zone. */
export const START_GAP = 240;
/** Reaching this gap means the player escaped. */
export const ESCAPE_GAP = 600;
/** The police waits this long (s) before it starts the chase. */
export const START_DELAY = 0.8;
/** Police top speed (km/h): a GT3 RS is fast, capable of 290 km/h in pursuit. */
export const POLICE_MAX = 290;
/** Police acceleration (km/h per s at low speed). */
export const POLICE_ACCEL = 58;

export type Zone = "green" | "yellow" | "orange" | "red";

export function policeZone(gap: number): Zone {
  if (gap >= 220) return "green";
  if (gap >= 120) return "yellow";
  if (gap >= 50) return "orange";
  return "red";
}

/** 0 = police on the player, 1 = escaped. */
export const escapeProgress = (gap: number) => Math.max(0, Math.min(1, gap / ESCAPE_GAP));

/** Police acceleration step (km/h) for one frame, never above POLICE_MAX. */
export function policeSpeedStep(speed: number, dt: number, cap = Infinity) {
  const target = Math.min(POLICE_MAX, cap);
  if (speed > target) return Math.max(target, speed - 150 * dt);
  const a = POLICE_ACCEL * (1 - (speed / POLICE_MAX) ** 2) + 4;
  return Math.min(target, speed + a * dt);
}

/**
 * The player is caught only when the police nose hits the Lamborghini's tail:
 * police behind (gap > 0), bumpers touching (gap < carLen) and both cars in the
 * same lane (lateral offset under ~half a car). Passing in another lane never busts.
 */
export function isRearHit(gap: number, lateral: number, carLen: number, carW: number) {
  return gap > 0 && gap < carLen && Math.abs(lateral) < carW * 0.55;
}

type Car = { lane: number; z: number; speed: number; hit?: boolean };

/** Is there room for the police in `lane` around z (no car ahead within `ahead`, none behind within `behind`)? */
export function policeLaneFree(cars: Car[], lane: number, z: number, ahead: number, behind: number) {
  return !cars.some((c) => !c.hit && c.lane === lane && c.z - z < ahead && z - c.z < behind);
}

/**
 * Lane the police wants: it stays behind traffic instead of driving through it,
 * overtakes through a free neighbouring lane, and otherwise lines up with the player.
 */
export function choosePoliceLane(
  cars: Car[],
  pol: { lane: number; z: number },
  playerLane: number,
  o: { ahead: number; behind: number; lanes?: number },
) {
  const lanes = o.lanes ?? 3;
  const blocked = !policeLaneFree(cars, pol.lane, pol.z, o.ahead, 0);
  const prefer = [playerLane, pol.lane - 1, pol.lane + 1];
  if (!blocked && pol.lane === playerLane) return pol.lane;
  for (const l of prefer) {
    if (l < 0 || l >= lanes || l === pol.lane) continue;
    if (Math.abs(l - pol.lane) !== 1) continue; // one lane at a time
    if (policeLaneFree(cars, l, pol.z, o.ahead, o.behind)) return l;
  }
  return pol.lane;
}
