/**
 * Camera — Orbital + MSFS-style free-flight modes.
 *
 * Improvements over v1:
 *  - Zoom level tracking (maps distance to a virtual zoom 0-18)
 *  - Smooth scroll easing with momentum
 *  - Drag momentum/inertia after release
 *  - Callback on zoom change for tile loading
 *  - Double-click to zoom in
 */

import * as THREE from 'three';
import { GLOBE_RADIUS } from './Globe';

export type CameraMode = 'orbit' | 'freeflight';

export interface CameraHandle {
  threeCamera: THREE.PerspectiveCamera;
  update(dt: number): void;
  setMode(mode: CameraMode): void;
  readonly mode: CameraMode;
  /** Get the current virtual zoom level (0 = far, ~18 = close) */
  getZoom(): number;
  /** Register a callback for zoom changes */
  onZoomChange(cb: (zoom: number) => void): void;
}

// ── Zoom ↔ Distance mapping ──────────────────────────────────────────
// Uses the same logarithmic scale as web map tile systems.
// zoom 0 → GLOBE_RADIUS * 50 (very far)
// zoom 6 → GLOBE_RADIUS * 1.5 (close enough for z6 tiles)
// zoom 18 → GLOBE_RADIUS * 1.001 (surface level)

const MIN_DISTANCE = GLOBE_RADIUS * 1.05;
const MAX_DISTANCE = GLOBE_RADIUS * 50;

function distanceToZoom(distance: number): number {
  // Logarithmic: zoom = log2(maxDist / dist) * scale
  const ratio = MAX_DISTANCE / distance;
  return Math.log2(ratio) * 2.5;
}

function zoomToDistance(zoom: number): number {
  const ratio = Math.pow(2, zoom / 2.5);
  return MAX_DISTANCE / ratio;
}

export function createCamera(container: HTMLElement): CameraHandle {
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1e7
  );

  let mode: CameraMode = 'orbit';

  // Orbit state
  let orbitPhi = 0;
  let orbitTheta = Math.PI / 4;
  let orbitDistance = GLOBE_RADIUS * 3;

  // Smooth zoom target (for easing)
  let targetDistance = orbitDistance;

  // Drag momentum
  let velPhi = 0;
  let velTheta = 0;
  let isDragging = false;
  let lastMouse = { x: 0, y: 0 };
  let lastMoveTime = 0;

  // Zoom callbacks
  const zoomCallbacks: Array<(zoom: number) => void> = [];
  let lastEmittedZoom = -1;

  // Free-flight state
  const ffPosition = new THREE.Vector3(0, GLOBE_RADIUS * 1.5, GLOBE_RADIUS * 2);
  const ffEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const keys: Record<string, boolean> = {};

  // ── Mouse orbit with momentum ──────────────────────────────────────

  container.addEventListener('mousedown', (e) => {
    if (mode === 'orbit') {
      isDragging = true;
      velPhi = 0;
      velTheta = 0;
      lastMouse = { x: e.clientX, y: e.clientY };
      lastMoveTime = performance.now();
    }
  });

  container.addEventListener('mousemove', (e) => {
    if (mode === 'orbit' && isDragging) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      const now = performance.now();
      const dt = Math.max((now - lastMoveTime) / 1000, 0.001);

      orbitPhi -= dx * 0.005;
      orbitTheta = Math.max(0.1, Math.min(Math.PI - 0.1, orbitTheta - dy * 0.005));

      // Track velocity for momentum
      velPhi = -dx * 0.005 / dt;
      velTheta = -dy * 0.005 / dt;

      lastMouse = { x: e.clientX, y: e.clientY };
      lastMoveTime = now;
    } else if (mode === 'freeflight') {
      ffEuler.y -= e.movementX * 0.002;
      ffEuler.x -= e.movementY * 0.002;
      ffEuler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, ffEuler.x));
    }
  });

  container.addEventListener('mouseup', () => { isDragging = false; });

  // ── Scroll zoom with easing ────────────────────────────────────────

  container.addEventListener('wheel', (e) => {
    if (mode === 'orbit') {
      e.preventDefault();
      // Zoom in = scroll down (positive deltaY)
      const zoomDelta = -e.deltaY * 0.002;
      const currentZoom = distanceToZoom(targetDistance);
      const newZoom = Math.max(0, Math.min(18, currentZoom + zoomDelta));
      targetDistance = zoomToDistance(newZoom);
      targetDistance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, targetDistance));
    }
  }, { passive: false });

  // ── Double-click to zoom in ────────────────────────────────────────

  container.addEventListener('dblclick', (e) => {
    if (mode === 'orbit') {
      const currentZoom = distanceToZoom(targetDistance);
      const newZoom = Math.min(18, currentZoom + 2);
      targetDistance = zoomToDistance(newZoom);
      targetDistance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, targetDistance));
    }
  });

  // ── Keyboard ───────────────────────────────────────────────────────

  window.addEventListener('keydown', (e) => { keys[e.code] = true; });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  // ── Touch support with momentum ────────────────────────────────────

  let lastTouchDist = 0;
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && mode === 'orbit') {
      isDragging = true;
      velPhi = 0;
      velTheta = 0;
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      lastMoveTime = performance.now();
    } else if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && mode === 'orbit' && isDragging) {
      const dx = e.touches[0].clientX - lastMouse.x;
      const dy = e.touches[0].clientY - lastMouse.y;
      const now = performance.now();
      const dt = Math.max((now - lastMoveTime) / 1000, 0.001);

      orbitPhi -= dx * 0.005;
      orbitTheta = Math.max(0.1, Math.min(Math.PI - 0.1, orbitTheta - dy * 0.005));

      velPhi = -dx * 0.005 / dt;
      velTheta = -dy * 0.005 / dt;

      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      lastMoveTime = now;
    } else if (e.touches.length === 2 && mode === 'orbit') {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const pinchScale = lastTouchDist / dist;
      targetDistance *= pinchScale;
      targetDistance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, targetDistance));
      lastTouchDist = dist;
    }
  }, { passive: true });

  container.addEventListener('touchend', () => { isDragging = false; }, { passive: true });

  // ── Pointer lock for free-flight ───────────────────────────────────

  container.addEventListener('click', () => {
    if (mode === 'freeflight') {
      container.requestPointerLock();
    }
  });

  // ── Update loop ────────────────────────────────────────────────────

  function update(dt: number) {
    if (mode === 'orbit') {
      // Apply drag momentum (deceleration)
      if (!isDragging) {
        const damping = Math.pow(0.05, dt); // exponential decay
        velPhi *= damping;
        velTheta *= damping;

        if (Math.abs(velPhi) > 0.001 || Math.abs(velTheta) > 0.001) {
          orbitPhi += velPhi * dt;
          orbitTheta = Math.max(0.1, Math.min(Math.PI - 0.1, orbitTheta + velTheta * dt));
        }
      }

      // Smooth zoom easing
      const zoomLerp = 1 - Math.pow(0.001, dt); // ~frame-rate independent
      orbitDistance += (targetDistance - orbitDistance) * zoomLerp;

      // Emit zoom change
      const currentZoom = distanceToZoom(orbitDistance);
      const roundedZoom = Math.round(currentZoom * 10) / 10;
      if (Math.abs(roundedZoom - lastEmittedZoom) >= 0.5) {
        lastEmittedZoom = roundedZoom;
        for (const cb of zoomCallbacks) cb(roundedZoom);
      }

      // Compute camera position on sphere
      const x = orbitDistance * Math.sin(orbitTheta) * Math.sin(orbitPhi);
      const y = orbitDistance * Math.cos(orbitTheta);
      const z = orbitDistance * Math.sin(orbitTheta) * Math.cos(orbitPhi);

      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);

    } else {
      // Free-flight: WASD + QE for altitude
      const speed = keys['ShiftLeft'] ? 500 : 100;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);

      if (keys['KeyW']) ffPosition.addScaledVector(forward, speed * dt);
      if (keys['KeyS']) ffPosition.addScaledVector(forward, -speed * dt);
      if (keys['KeyA']) ffPosition.addScaledVector(right, -speed * dt);
      if (keys['KeyD']) ffPosition.addScaledVector(right, speed * dt);
      if (keys['KeyQ']) ffPosition.y -= speed * dt;
      if (keys['KeyE']) ffPosition.y += speed * dt;

      camera.position.copy(ffPosition);
      camera.quaternion.setFromEuler(ffEuler);

      // Clamp altitude
      const distFromCenter = ffPosition.length();
      if (distFromCenter < GLOBE_RADIUS * 1.001) {
        ffPosition.normalize().multiplyScalar(GLOBE_RADIUS * 1.001);
      } else if (distFromCenter > GLOBE_RADIUS * 10) {
        ffPosition.normalize().multiplyScalar(GLOBE_RADIUS * 10);
      }
    }
  }

  function setMode(newMode: CameraMode) {
    mode = newMode;
    if (mode === 'freeflight') {
      ffPosition.copy(camera.position);
      ffEuler.setFromQuaternion(camera.quaternion);
    }
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  function getZoom(): number {
    return distanceToZoom(orbitDistance);
  }

  function onZoomChange(cb: (zoom: number) => void): void {
    zoomCallbacks.push(cb);
  }

  return { threeCamera: camera, update, setMode, get mode() { return mode; }, getZoom, onZoomChange };
}
