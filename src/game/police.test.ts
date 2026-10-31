import { describe, expect, it } from "vitest";
import { choosePoliceLane, isRearHit } from "./police";

describe("police arrest rule", () => {
  it("busts only on a rear hit in the same lane", () => {
    expect(isRearHit(10, 0, 14, 40)).toBe(true);
  });
  it("does not bust when the police passes in another lane", () => {
    expect(isRearHit(5, 70, 14, 40)).toBe(false);
  });
  it("does not bust when the police is already ahead", () => {
    expect(isRearHit(-5, 0, 14, 40)).toBe(false);
  });
});

describe("police vs traffic", () => {
  it("moves to a free lane instead of driving through a car", () => {
    const cars = [{ lane: 1, z: 110, speed: 90 }];
    expect(choosePoliceLane(cars, { lane: 1, z: 100 }, 1, { ahead: 40, behind: 15 })).not.toBe(1);
  });
  it("stays in lane when every neighbour lane is busy", () => {
    const cars = [
      { lane: 1, z: 110, speed: 90 },
      { lane: 0, z: 100, speed: 90 },
      { lane: 2, z: 102, speed: 90 },
    ];
    expect(choosePoliceLane(cars, { lane: 1, z: 100 }, 1, { ahead: 40, behind: 15 })).toBe(1);
  });
});
