import { describe, expect, it } from "vitest";

import { blockedLanes, wallSpeedCaps, type LaneCar } from "./traffic";

const CAR = 4.5; // meters
const WALL = CAR * 3.5;

/** Smallest z-span that contains one car in every lane (Infinity if a lane is empty). */
function tightestWall(cars: LaneCar[]) {
  let best = Infinity;
  for (const a of cars.filter((c) => c.lane === 0))
    for (const b of cars.filter((c) => c.lane === 1))
      for (const c of cars.filter((c) => c.lane === 2)) {
        const zs = [a.z, b.z, c.z];
        best = Math.min(best, Math.max(...zs) - Math.min(...zs));
      }
  return best;
}

describe("traffic always leaves a way through", () => {
  it("slows the car that would close a three-lane wall", () => {
    const cars: LaneCar[] = [
      { lane: 0, z: 100, speed: 90 },
      { lane: 1, z: 104, speed: 100 },
      { lane: 2, z: 80, speed: 160 }, // fast car catching up from behind
    ];
    const caps = wallSpeedCaps(cars, WALL);
    expect(caps[2]).toBeLessThan(90);
    expect(caps[0]).toBe(Infinity);
    expect(caps[1]).toBe(Infinity);
  });

  it("does not slow anyone when a lane is free", () => {
    const cars: LaneCar[] = [
      { lane: 0, z: 100, speed: 90 },
      { lane: 1, z: 80, speed: 160 },
    ];
    expect(wallSpeedCaps(cars, WALL)).toEqual([Infinity, Infinity]);
  });

  it("never lets three cars line up across the road during a long drive", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let cars: LaneCar[] = [];
    let nextZ = 60;
    let pz = 0;
    let worst = Infinity;
    const dt = 1 / 60;
    for (let step = 0; step < 60 * 180; step++) {
      pz += (280 / 3.6) * dt; // player cruising at 280 km/h
      while (nextZ < pz + 80) {
        const blocked = blockedLanes(cars, nextZ, WALL);
        const free = [0, 1, 2].filter((l) => !blocked.has(l));
        if (free.length > 1) {
          const speed = 70 + rand() * 95;
          cars.push({ lane: free[Math.floor(rand() * free.length)]!, z: nextZ, speed });
        }
        nextZ += CAR * (1.2 + rand() * 1.5);
      }
      const caps = wallSpeedCaps(cars, WALL);
      cars.forEach((c, i) => {
        const cruise = Math.min(165, caps[i] ?? Infinity);
        c.speed += (cruise - c.speed) * (1 - Math.exp(-4 * dt));
        c.z += (c.speed / 3.6) * dt;
      });
      cars = cars.filter((c) => c.z > pz - 40);
      worst = Math.min(worst, tightestWall(cars));
    }
    // there is always at least ~2.4 car lengths between the cars to slip through
    expect(worst).toBeGreaterThan(CAR * 2.4);
  });
});
