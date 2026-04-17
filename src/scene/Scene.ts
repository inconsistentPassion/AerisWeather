/**
 * Scene — Creates the Three.js renderer and scene.
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
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000008); // near-black space

  // Sun as directional light
  const sun = new THREE.DirectionalLight(0xffeedd, 1.8);
  sun.position.set(50000, 30000, -40000);
  scene.add(sun);

  // Ambient fill
  const ambient = new THREE.AmbientLight(0x334466, 0.3);
  scene.add(ambient);

  return { renderer, scene };
}
