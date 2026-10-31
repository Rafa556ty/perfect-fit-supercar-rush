// Rendering quality only; simulation and traffic density never change.
export function phoneProfile(device: { userAgent: string; memory?: number | undefined; cores: number; touch: boolean }) {
  return /SM-A115|Galaxy A11/i.test(device.userAgent) ||
    (device.touch && (device.memory === undefined || device.memory <= 4 || device.cores <= 8));
}

export class AdaptiveResolution {
  scale = 1;
  private elapsed = 0;
  private frames = 0;
  private stable = 0;

  sample(seconds: number, hidden = false): boolean {
    if (hidden || seconds <= 0 || seconds > 0.25) return false;
    this.elapsed += seconds;
    this.frames++;
    if (this.elapsed < 3) return false;
    const average = this.elapsed / this.frames;
    this.elapsed = 0;
    this.frames = 0;
    const previous = this.scale;
    if (average > 1 / 26) {
      this.scale = Math.max(0.65, this.scale - 0.15);
      this.stable = 0;
    } else if (average < 1 / 50) {
      this.stable++;
      if (this.stable >= 5) {
        this.scale = Math.min(1, this.scale + 0.15);
        this.stable = 0;
      }
    } else this.stable = 0;
    return previous !== this.scale;
  }
}