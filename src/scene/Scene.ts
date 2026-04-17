/**
 * Scene — Creates the Three.js renderer and scene.
 * Enhanced with better lighting and exposure for visual polish.
 */

import * as THREE from 'three';

export function createScene(container: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    logarithmicDepthBuffer: true, // critical for globe scale
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000510);

  // Main sun light (warm white)
  const sun = new THREE.DirectionalLight(0xfff5e0, 2.0);
  sun.position.set(50000, 30000, -40000);
  scene.add(sun);

  // Cool ambient fill (prevents pure black shadows)
  const ambient = new THREE.AmbientLight(0x334466, 0.25);
  scene.add(ambient);

  // Hemisphere light for sky/ground color variation
  const hemi = new THREE.HemisphereLight(0x88aaff, 0x443322, 0.15);
  scene.add(hemi);

  // Expose the scene sun for GlobeLighting to reference
  (scene as any).__sun = sun;

  return { renderer, scene };
}
