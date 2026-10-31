import { describe, expect, it } from "vitest";

import { GEARS, SHIFT_UP, pickGear, rpmIn } from "./gearbox";

describe("gearbox", () => {
  it("has 8 gears like the Revuelto", () => {
    expect(GEARS).toBe(8);
  });

  it("starts in first gear when stopped", () => {
    expect(pickGear(0, 0, true)).toBe(0);
  });

  it("upshifts only when rpm reaches the shift point at full throttle", () => {
    expect(pickGear(0, 72, true)).toBe(0); // 9,120 rpm: keep pulling
    expect(pickGear(0, 74, true)).toBe(1); // 9,373 rpm: shift
  });

  it("never upshifts past the last gear at top speed", () => {
    expect(pickGear(7, 340, true)).toBe(7);
    expect(rpmIn(7, 340)).toBeLessThan(SHIFT_UP);
  });

  it("does not bounce back down right after an upshift", () => {
    let gear = 0;
    let shifts = 0;
    for (let speed = 0; speed <= 340; speed += 0.5) {
      const next = pickGear(gear, speed, true);
      if (next < gear) throw new Error(`downshift at ${speed}`);
      if (next > gear) shifts++;
      gear = next;
    }
    expect(gear).toBe(7);
    expect(shifts).toBe(7);
  });

  it("downshifts when braking to low speed", () => {
    expect(pickGear(7, 40, false)).toBe(0);
  });
});
