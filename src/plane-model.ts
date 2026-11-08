// The airliner drawn on the globe: a small glTF model (Boeing 787-style,
// "Airplane" by Poly by Google, CC-BY 3.0 — see CREDITS.md), kept at a
// constant size on screen, with red/green wingtip navigation lights.
//
// Model frame (as shipped): nose +Z, up +Y, wings along X — so +X is the
// LEFT wing (X = Y × Z). We normalise it to length 1, centred on its bounding
// box, then orient it every frame from the flight's (heading, radial up).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import planeModelUrl from './models/airplane.glb?url';

// On-screen length of the plane, in CSS pixels, whatever the zoom.
export const PLANE_SCREEN_PX = 46;

export function createPlane() {
  const group = new THREE.Group();     // positioned + oriented by the caller
  const body  = new THREE.Group();     // model, normalised to length 1
  group.add(body);
  group.visible = false;

  // Placeholder until the model arrives (and fallback if it fails to load):
  // the old cone, laid along +Z.
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 1, 12).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffee55, toneMapped: false }),
  );
  body.add(cone);

  new GLTFLoader().load(planeModelUrl, (gltf) => {
    const model = gltf.scene;
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      // The file has no normals; flat shading suits its low-poly look.
      o.geometry = o.geometry.toNonIndexed();
      o.geometry.computeVertexNormals();
      const m = o.material as THREE.MeshStandardMaterial;
      m.flatShading = true;
      // A little self-light so it stays readable on the night side.
      m.emissive = m.color.clone().multiplyScalar(0.35);
      m.needsUpdate = true;
    });
    // Centre on the bounding box and scale so nose-to-tail = 1.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const k = 1 / size.z;
    model.scale.setScalar(k);
    model.position.copy(centre).multiplyScalar(-k);

    // Navigation lights at the wingtips: red on the left (+X), green right.
    const tipX = size.x * k / 2, tipZ = (box.min.z + 0.3 * size.z - centre.z) * k;
    const tipY = (box.min.y + 0.38 * size.y - centre.y) * k;   // wingtips sit a bit below mid-height
    const light = (color: number, x: number) => {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 10, 8),
        new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false }),
      );
      s.position.set(x, tipY, tipZ);
      return s;
    };
    body.remove(cone);
    cone.geometry.dispose(); (cone.material as THREE.Material).dispose();
    body.add(model, light(0xff3030, tipX), light(0x30ff60, -tipX));
  }, undefined, (err) => console.warn('plane model failed to load, keeping the cone', err));

  const basis = new THREE.Matrix4();
  const up = new THREE.Vector3(), left = new THREE.Vector3();
  const worldPos = new THREE.Vector3();

  return {
    group,
    // pos: unit vector (Earth-local), heading: unit tangent, r: radius to sit at.
    place(pos: THREE.Vector3, heading: THREE.Vector3, r: number) {
      up.copy(pos).normalize();
      left.crossVectors(up, heading).normalize();          // X = Y × Z
      basis.makeBasis(left, up, heading);
      group.quaternion.setFromRotationMatrix(basis);
      group.position.copy(up).multiplyScalar(r);
    },
    // Constant pixel size: world length = px · 2·d·tan(fov/2) / viewport height.
    fitToScreen(camera: THREE.PerspectiveCamera, viewportHeightPx: number) {
      if (!group.visible) return;
      group.getWorldPosition(worldPos);
      const d = worldPos.distanceTo(camera.position);
      const len = PLANE_SCREEN_PX * 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / viewportHeightPx;
      // The group's parent (the Earth) is unscaled, so this is world length.
      body.scale.setScalar(len);
      body.position.y = len * 0.2;   // ride just above the route line, not through it
    },
  };
}
