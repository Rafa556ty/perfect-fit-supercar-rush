import * as THREE from "three";

/** Never overwrite exporter rotations: yaw and grounding use separate parents. */
export function normalizeCar(scene: THREE.Group, spec: { length: number; yaw: number }): THREE.Group {
  const grounded = new THREE.Group();
  const heading = new THREE.Group();
  grounded.add(heading);
  heading.add(scene);
  heading.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(heading);
  const size = box.getSize(new THREE.Vector3());
  heading.rotation.y = (size.x > size.z ? Math.PI / 2 : 0) + spec.yaw;
  heading.updateMatrixWorld(true);
  const head: number[] = [];
  const tail: number[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const label = `${object.name} ${materials.map((m) => m.name).join(" ")}`.toLowerCase();
    const z = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3()).z;
    if (/tail|rear_light|red_glass|glassred|lightglass_red|exhaust/.test(label)) tail.push(z);
    else if (/headlight|daylight|head_light/.test(label)) head.push(z);
  });
  const average = (values: number[]) => values.reduce((sum, z) => sum + z, 0) / values.length;
  const centre = new THREE.Box3().setFromObject(heading).getCenter(new THREE.Vector3()).z;
  if (spec.yaw === 0 && (tail.length ? (head.length ? average(head) > average(tail) : average(tail) < centre) : head.length ? average(head) > centre : true)) heading.rotation.y += Math.PI;
  heading.updateMatrixWorld(true);
  box.setFromObject(heading);
  heading.scale.setScalar(spec.length / Math.max(box.getSize(size).z, 1e-6));
  heading.updateMatrixWorld(true);
  box.setFromObject(heading);
  const center = box.getCenter(new THREE.Vector3());
  heading.position.set(-center.x, -box.min.y, -center.z);
  grounded.updateMatrixWorld(true);
  return grounded;
}