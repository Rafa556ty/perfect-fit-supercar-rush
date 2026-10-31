import { describe, expect, it } from "vitest";
import { AdaptiveResolution, phoneProfile } from "./quality";

describe("phone rendering", () => {
  it("selects the lightweight profile for Galaxy A11", () => {
    expect(phoneProfile({ userAgent: "Android SM-A115M", cores: 8, memory: 2, touch: true })).toBe(true);
    expect(phoneProfile({ userAgent: "Desktop", cores: 16, memory: 16, touch: false })).toBe(false);
  });
  it("reduces resolution on sustained slow frames, bounded at 65%", () => {
    const quality = new AdaptiveResolution();
    for (let i = 0; i < 400; i++) quality.sample(0.05);
    expect(quality.scale).toBe(0.65);
  });
  it("ignores background frames and restores resolution after sustained fast frames", () => {
    const quality = new AdaptiveResolution();
    for (let i = 0; i < 70; i++) quality.sample(0.05);
    expect(quality.scale).toBe(0.85);
    for (let i = 0; i < 400; i++) quality.sample(0.05, true);
    expect(quality.scale).toBe(0.85);
    for (let i = 0; i < 1200; i++) quality.sample(1 / 60);
    expect(quality.scale).toBe(1);
  });
});