import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { normalizeCar } from "./normalize-car";

describe("imported car orientation", () => {
  it("preserves exporter axis conversion, faces forward and rests on the road", () => {
    const scene = new THREE.Group();
    scene.rotation.x = Math.PI / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 5, 1));
    scene.add(body);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, 0.1));
    tail.name = "Tail_light";
    tail.position.y = -2.5;
    scene.add(tail);
    const original = scene.quaternion.clone();
    const car = normalizeCar(scene, { length: 4.95, yaw: 0 });
    const box = new THREE.Box3().setFromObject(car);
    const size = box.getSize(new THREE.Vector3());
    expect(scene.quaternion.equals(original)).toBe(true);
    expect(size.z).toBeCloseTo(4.95);
    expect(size.x).toBeLessThan(size.z);
    expect(size.y).toBeLessThan(size.x);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(new THREE.Box3().setFromObject(tail).getCenter(new THREE.Vector3()).z).toBeGreaterThan(0);
  });
});