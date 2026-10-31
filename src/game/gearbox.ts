// 8-speed dual-clutch gearbox, like the real Revuelto (V12 redline ≈ 9,500 rpm).

/** Speed (km/h) each gear reaches at redline. Ratios get closer in the high gears. */
export const GEAR_TOP = [75, 115, 155, 195, 235, 275, 312, 352];
export const GEARS = GEAR_TOP.length;
export const IDLE_RPM = 1000;
export const REDLINE = 9500;
/** Full-throttle upshift point, just before the limiter. */
export const SHIFT_UP = 9250;

export const rpmIn = (gear: number, speed: number) => (REDLINE * speed) / (GEAR_TOP[gear] ?? GEAR_TOP[GEARS - 1]!);

/**
 * Pick the gear (0-based) for a speed. Under throttle it upshifts at SHIFT_UP;
 * in the last gear there is nothing left to shift to. Downshifts when rpm falls
 * low (kick-down under throttle, engine braking when coasting / braking).
 */
export function pickGear(gear: number, speed: number, throttle: boolean) {
  let g = Math.max(0, Math.min(GEARS - 1, gear));
  while (g < GEARS - 1 && rpmIn(g, speed) >= (throttle ? SHIFT_UP : REDLINE)) g++;
  const downAt = throttle ? 5500 : 3500;
  while (g > 0 && rpmIn(g, speed) < downAt && rpmIn(g - 1, speed) < 8500) g--;
  return g;
}
