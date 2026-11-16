// Live readout floating next to the plane on the globe (#plane-label).
//
// main.ts fills the text when the flight time changes (setContent) and calls
// place() on every rendered frame. place() projects the plane to the screen
// and puts the label at one of the four diagonal corners around it, picking
// the one that stays on screen and clear of the panels; the previous corner
// wins ties so the label doesn't flicker while the plane moves.
//
// When the Earth hides the plane (the camera is on the other side), the label
// stays on the globe's rim in the plane's direction, dimmed, so the readout
// never disappears.
import * as THREE from 'three';
import { PLANE_SCREEN_PX } from './plane-model';

type Corner = 'tr' | 'tl' | 'br' | 'bl';   // label position relative to the plane
const CORNERS: Corner[] = ['tr', 'tl', 'br', 'bl'];
const GAP = Math.round(PLANE_SCREEN_PX * 0.45);   // clears the plane drawing
const MARGIN = 8;

export type PlaneLabel = ReturnType<typeof createPlaneLabel>;

export function createPlaneLabel(el: HTMLElement, onResize: () => void) {
  const mainEl    = el.querySelector('.pl-main')    as HTMLDivElement;
  const detailsEl = el.querySelector('.pl-details') as HTMLDivElement;
  let corner: Corner = 'tr';
  let w = 0, h = 0;               // label size, re-measured when the text changes
  let measured = false;

  const tmp = new THREE.Vector3();
  const centre = new THREE.Vector3();

  el.addEventListener('click', () => {
    el.classList.toggle('expanded');
    measured = false;
    onResize();
  });

  function setContent(mainHtml: string, detailsHtml: string) {
    mainEl.innerHTML = mainHtml;
    detailsEl.innerHTML = detailsHtml;
    measured = false;
  }

  function hide() { el.classList.remove('visible'); }

  // Is the straight line from the camera to p blocked by the sphere?
  function occluded(p: THREE.Vector3, cam: THREE.Vector3, r: number): boolean {
    const d = tmp.copy(cam).sub(p);
    const t = THREE.MathUtils.clamp(-p.dot(d) / d.lengthSq(), 0, 1);
    if (t <= 0) return false;
    return d.multiplyScalar(t).add(p).length() < r;
  }

  function toScreen(v: THREE.Vector3, camera: THREE.PerspectiveCamera, W: number, H: number): [number, number] {
    tmp.copy(v).project(camera);
    return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H];
  }

  // Overlap area of the label rect with r (0 when apart).
  function overlap(x: number, y: number, r: DOMRect): number {
    const ox = Math.min(x + w, r.right) - Math.max(x, r.left);
    const oy = Math.min(y + h, r.bottom) - Math.max(y, r.top);
    return ox > 0 && oy > 0 ? ox * oy : 0;
  }

  /**
   * @param planeWorld  plane position in world space
   * @param earthRadius globe radius (world units); the Earth sits at the origin
   * @param obstacles   screen rects to keep clear of (panels, window view)
   */
  function place(
    camera: THREE.PerspectiveCamera, planeWorld: THREE.Vector3, earthRadius: number,
    obstacles: DOMRect[],
  ) {
    el.classList.add('visible');
    if (!measured) { w = el.offsetWidth; h = el.offsetHeight; measured = true; }
    const W = window.innerWidth, H = window.innerHeight;

    const behind = occluded(planeWorld, camera.position, earthRadius);
    el.classList.toggle('behind', behind);
    let [ax, ay] = toScreen(planeWorld, camera, W, H);
    if (behind) {
      // Push the anchor out to the globe's visible rim, along the direction
      // from the globe's centre to where the plane projects.
      const [cx, cy] = toScreen(centre.set(0, 0, 0), camera, W, H);
      const dist = camera.position.length();
      const limbPx = (H / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) *
        Math.tan(Math.asin(Math.min(1, earthRadius / dist)));
      let dx = ax - cx, dy = ay - cy;
      const len = Math.hypot(dx, dy);
      if (len < 1) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
      ax = cx + dx * limbPx;
      ay = cy + dy * limbPx;
    }

    const pos = (c: Corner): [number, number] => [
      c === 'tr' || c === 'br' ? ax + GAP : ax - GAP - w,
      c === 'tr' || c === 'tl' ? ay - GAP - h : ay + GAP,
    ];
    const cost = (c: Corner) => {
      const [x, y] = pos(c);
      // Area falling off screen, plus area under a panel.
      const vis = Math.max(0, Math.min(x + w, W - MARGIN) - Math.max(x, MARGIN)) *
                  Math.max(0, Math.min(y + h, H - MARGIN) - Math.max(y, MARGIN));
      let c2 = w * h - vis;
      for (const r of obstacles) c2 += overlap(x, y, r);
      return c2;
    };
    let best = corner, bestCost = cost(corner);
    for (const c of CORNERS) {
      const k = cost(c);
      if (k < bestCost - 1) { best = c; bestCost = k; }
    }
    corner = best;
    let [x, y] = pos(corner);
    x = THREE.MathUtils.clamp(x, MARGIN, Math.max(MARGIN, W - w - MARGIN));
    y = THREE.MathUtils.clamp(y, MARGIN, Math.max(MARGIN, H - h - MARGIN));
    // The corner of the label nearest the plane is squared off (CSS).
    const pointing: Record<Corner, string> = { tr: 'bl', tl: 'br', br: 'tl', bl: 'tr' };
    el.dataset.corner = pointing[corner];
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  return { setContent, hide, place };
}
