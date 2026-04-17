/**
 * Skybox — Procedural starfield sphere.
 * Generates random stars on a distant sphere for space context.
 */

import * as THREE from 'three';

export function createSkybox(): THREE.Points {
  const STAR_COUNT = 8000;
  const SKY_RADIUS = 500000; // Far beyond the globe

  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);

  for (let i = 0; i < STAR_COUNT; i++) {
    // Random point on sphere (uniform distribution)
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i * 3] = SKY_RADIUS * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = SKY_RADIUS * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = SKY_RADIUS * Math.cos(phi);

    // Star color temperature (blue-white → yellow → orange)
    const temp = Math.random();
    if (temp < 0.3) {
      // Blue-white (hot)
      colors[i * 3] = 0.8 + Math.random() * 0.2;
      colors[i * 3 + 1] = 0.85 + Math.random() * 0.15;
      colors[i * 3 + 2] = 1.0;
    } else if (temp < 0.7) {
      // White (medium)
      colors[i * 3] = 1.0;
      colors[i * 3 + 1] = 0.98 + Math.random() * 0.02;
      colors[i * 3 + 2] = 0.95 + Math.random() * 0.05;
    } else {
      // Orange-yellow (cool)
      colors[i * 3] = 1.0;
      colors[i * 3 + 1] = 0.7 + Math.random() * 0.2;
      colors[i * 3 + 2] = 0.4 + Math.random() * 0.3;
    }

    // Star size (most are small, few are bright)
    const brightness = Math.random();
    sizes[i] = brightness < 0.9 ? 1.0 + Math.random() : 2.0 + Math.random() * 2.0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;

      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;

      void main() {
        // Soft circular star shape
        float dist = length(gl_PointCoord - vec2(0.5));
        float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
        alpha = pow(alpha, 2.0);

        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'starfield';

  return points;
}
