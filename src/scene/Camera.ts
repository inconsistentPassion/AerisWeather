/**
 * Camera — Orbital + MSFS-style free-flight modes.
 */

import * as THREE from 'three';
import { GLOBE_RADIUS } from './Globe';

export type CameraMode = 'orbit' | 'freeflight';

export function createCamera(container: HTMLElement) {
  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1e7
  );

  // Start in orbit mode
  let mode: CameraMode = 'orbit';

  // Orbit state
  let orbitPhi = 0;
  let orbitTheta = Math.PI / 4;
  let orbitDistance = GLOBE_RADIUS * 3;

  // Free-flight state
  const ffPosition = new THREE.Vector3(0, GLOBE_RADIUS * 1.5, GLOBE_RADIUS * 2);
  const ffEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const ffVelocity = new THREE.Vector3();

  const keys: Record<string, boolean> = {};

  // Mouse orbit
  let isDragging = false;
  let lastMouse = { x: 0, y: 0 };

  container.addEventListener('mousedown', (e) => {
    if (mode === 'orbit') {
      isDragging = true;
      lastMouse = { x: e.clientX, y: e.clientY };
    }
  });

  container.addEventListener('mousemove', (e) => {
    if (mode === 'orbit' && isDragging) {
      const dx = e.clientX - lastMouse.x;
      const dy = e.clientY - lastMouse.y;
      orbitPhi -= dx * 0.005;
      orbitTheta = Math.max(0.1, Math.min(Math.PI - 0.1, orbitTheta - dy * 0.005));
      lastMouse = { x: e.clientX, y: e.clientY };
    } else if (mode === 'freeflight') {
      ffEuler.y -= e.movementX * 0.002;
      ffEuler.x -= e.movementY * 0.002;
      ffEuler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, ffEuler.x));
    }
  });

  container.addEventListener('mouseup', () => { isDragging = false; });

  container.addEventListener('wheel', (e) => {
    if (mode === 'orbit') {
      orbitDistance *= 1 + e.deltaY * 0.001;
      orbitDistance = Math.max(GLOBE_RADIUS * 1.2, Math.min(GLOBE_RADIUS * 50, orbitDistance));
    }
  });

  // Keyboard
  window.addEventListener('keydown', (e) => { keys[e.code] = true; });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  // Touch support
  let lastTouchDist = 0;
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1 && mode === 'orbit') {
      isDragging = true;
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
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
      orbitPhi -= dx * 0.005;
      orbitTheta = Math.max(0.1, Math.min(Math.PI - 0.1, orbitTheta - dy * 0.005));
      lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2 && mode === 'orbit') {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      orbitDistance *= lastTouchDist / dist;
      orbitDistance = Math.max(GLOBE_RADIUS * 1.2, Math.min(GLOBE_RADIUS * 50, orbitDistance));
      lastTouchDist = dist;
    }
  }, { passive: true });

  container.addEventListener('touchend', () => { isDragging = false; }, { passive: true });

  // Pointer lock for free-flight
  container.addEventListener('click', () => {
    if (mode === 'freeflight') {
      container.requestPointerLock();
    }
  });

  function update(dt: number) {
    if (mode === 'orbit') {
      // Update orbit camera
      const x = orbitDistance * Math.sin(orbitTheta) * Math.sin(orbitPhi);
      const y = orbitDistance * Math.cos(orbitTheta);
      const z = orbitDistance * Math.sin(orbitTheta) * Math.cos(orbitPhi);

      camera.position.set(x, y, z);
      camera.lookAt(0, 0, 0);

      // Update atmosphere uniform if accessible
      // (handled by scene update)
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

      // Clamp altitude (don't go through the earth or too far up)
      const distFromCenter = ffPosition.length();
      const minAlt = GLOBE_RADIUS * 1.001;
      const maxAlt = GLOBE_RADIUS * 10;
      if (distFromCenter < minAlt) {
        ffPosition.normalize().multiplyScalar(minAlt);
      } else if (distFromCenter > maxAlt) {
        ffPosition.normalize().multiplyScalar(maxAlt);
      }
    }
  }

  function setMode(newMode: CameraMode) {
    mode = newMode;
    if (mode === 'freeflight') {
      // Transfer current orbit position to free-flight
      ffPosition.copy(camera.position);
      ffEuler.setFromQuaternion(camera.quaternion);
    }
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
  }

  return {
    threeCamera: camera,
    update,
    setMode,
    get mode() { return mode; },
  };
}
