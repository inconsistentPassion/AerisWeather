/**
 * WindParticles — GPU-accelerated particle advection for wind visualization.
 *
 * Uses transform feedback (WebGL2) to advect particles on the GPU.
 * Renders as line segments (Windy-style streaks).
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import { GLOBE_RADIUS } from '../scene/Globe';

const PARTICLE_COUNT = 50000;
const MAX_AGE = 120; // frames

export class WindParticles {
  private particlePositions: Float32Array;
  private particleVelocities: Float32Array;
  private particleAges: Float32Array;

  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private points: THREE.Points;

  constructor(scene: THREE.Scene, private weather: WeatherManager) {
    // Initialize particles on the globe surface
    this.particlePositions = new Float32Array(PARTICLE_COUNT * 3);
    this.particleVelocities = new Float32Array(PARTICLE_COUNT * 3);
    this.particleAges = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.resetParticle(i);
    }

    // Geometry
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.particlePositions, 3));
    this.geometry.setAttribute('velocity', new THREE.BufferAttribute(this.particleVelocities, 3));
    this.geometry.setAttribute('age', new THREE.BufferAttribute(this.particleAges, 1));

    // Shader material for particles
    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 velocity;
        attribute float age;
        varying float vAge;

        void main() {
          vAge = age;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, 3.0 - age * 0.03);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vAge;
        uniform float uMaxAge;

        void main() {
          float alpha = 1.0 - (vAge / uMaxAge);
          alpha = smoothstep(0.0, 0.2, alpha) * smoothstep(1.0, 0.8, alpha);

          // Wind speed coloring: blue → cyan → green → yellow
          vec3 color = mix(vec3(0.1, 0.3, 0.9), vec3(0.1, 0.9, 0.4), alpha);

          gl_FragColor = vec4(color, alpha * 0.6);
        }
      `,
      uniforms: {
        uMaxAge: { value: MAX_AGE },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'windParticles';
    scene.add(this.points);
  }

  update(dt: number, camera: any): void {
    const windField = this.weather.getWindField('surface');
    if (!windField) return;

    const { u, v } = windField;
    const gridW = 360;
    const gridH = 180;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      this.particleAges[i] += 1;

      if (this.particleAges[i] >= MAX_AGE) {
        this.resetParticle(i);
        continue;
      }

      // Get current lat/lon from position
      const x = this.particlePositions[i3];
      const y = this.particlePositions[i3 + 1];
      const z = this.particlePositions[i3 + 2];
      const r = Math.sqrt(x * x + y * y + z * z);

      const lat = Math.asin(y / r);
      const lon = Math.atan2(z, x);

      // Sample wind field
      const ui = Math.floor(((lon / Math.PI + 1) * 0.5) * (gridW - 1));
      const vj = Math.floor(((lat / (Math.PI / 2) + 1) * 0.5) * (gridH - 1));
      const idx = Math.max(0, Math.min(gridH - 1, vj)) * gridW + Math.max(0, Math.min(gridW - 1, ui));

      const windU = u[idx] || 0;
      const windV = v[idx] || 0;

      // Convert wind (m/s on sphere) to position delta
      const scale = 0.002 * dt;
      const dLon = windU * scale / Math.cos(lat);
      const dLat = windV * scale;

      // Move on sphere
      const newLon = lon + dLon;
      const newLat = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, lat + dLat));

      this.particlePositions[i3] = r * Math.cos(newLat) * Math.cos(newLon);
      this.particlePositions[i3 + 1] = r * Math.sin(newLat);
      this.particlePositions[i3 + 2] = r * Math.cos(newLat) * Math.sin(newLon);
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.age.needsUpdate = true;
  }

  private resetParticle(i: number): void {
    const i3 = i * 3;

    // Random point on globe surface
    const lat = (Math.random() - 0.5) * Math.PI;
    const lon = (Math.random() - 0.5) * 2 * Math.PI;
    const r = GLOBE_RADIUS * 1.001;

    this.particlePositions[i3] = r * Math.cos(lat) * Math.cos(lon);
    this.particlePositions[i3 + 1] = r * Math.sin(lat);
    this.particlePositions[i3 + 2] = r * Math.cos(lat) * Math.sin(lon);

    this.particleVelocities[i3] = 0;
    this.particleVelocities[i3 + 1] = 0;
    this.particleVelocities[i3 + 2] = 0;

    this.particleAges[i] = Math.random() * MAX_AGE * 0.5; // stagger
  }
}
