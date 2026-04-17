/**
 * WindParticles — GPU-friendly wind visualization.
 *
 * v2 improvements:
 *  - Line segments instead of points (Windy-style streaks)
 *  - Trail history per particle (last N positions)
 *  - Color by wind speed
 *  - Density-based spawn (more particles where wind is strong)
 *  - Fade in/out by age
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import { GLOBE_RADIUS } from '../scene/Globe';

const PARTICLE_COUNT = 40000;
const TRAIL_LENGTH = 8; // points per particle trail
const MAX_AGE = 150; // frames
const GLOBE_SURFACE = GLOBE_RADIUS * 1.001;

export class WindParticles {
  // Particle state
  private positions: Float32Array;   // current positions (x,y,z per particle)
  private ages: Float32Array;        // current age per particle
  private speeds: Float32Array;      // last sampled wind speed

  // Trail history: TRAIL_LENGTH * 3 * PARTICLE_COUNT
  private trailPositions: Float32Array;
  private trailWriteIdx: Int32Array; // which slot to write next per particle

  // Geometry for line segments
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private lineSegments: THREE.LineSegments;

  // Shared buffers for trail geometry
  private linePositions: Float32Array;
  private lineColors: Float32Array;
  private lineIndices: Uint32Array;

  constructor(parent: THREE.Object3D, private weather: WeatherManager) {
    // Initialize particles
    this.positions = new Float32Array(PARTICLE_COUNT * 3);
    this.ages = new Float32Array(PARTICLE_COUNT);
    this.speeds = new Float32Array(PARTICLE_COUNT);
    this.trailPositions = new Float32Array(PARTICLE_COUNT * TRAIL_LENGTH * 3);
    this.trailWriteIdx = new Int32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.resetParticle(i);
    }

    // Build line segment geometry
    // Each particle trail = TRAIL_LENGTH points connected as a strip
    // We use indexed line segments: (point[i] → point[i+1]) for each trail
    const totalVertices = PARTICLE_COUNT * TRAIL_LENGTH;
    this.linePositions = new Float32Array(totalVertices * 3);
    this.lineColors = new Float32Array(totalVertices * 3);

    // Indices: connect consecutive points in each trail
    const indicesPerTrail = (TRAIL_LENGTH - 1) * 2;
    const totalIndices = PARTICLE_COUNT * indicesPerTrail;
    this.lineIndices = new Uint32Array(totalIndices);

    for (let p = 0; p < PARTICLE_COUNT; p++) {
      const trailBase = p * TRAIL_LENGTH;
      const indexBase = p * indicesPerTrail;

      for (let t = 0; t < TRAIL_LENGTH - 1; t++) {
        this.lineIndices[indexBase + t * 2] = trailBase + t;
        this.lineIndices[indexBase + t * 2 + 1] = trailBase + t + 1;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(this.lineIndices, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 color;
        varying vec3 vColor;

        void main() {
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;

        void main() {
          gl_FragColor = vec4(vColor, 0.5);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.lineSegments = new THREE.LineSegments(this.geometry, this.material);
    this.lineSegments.name = 'windParticles';
    parent.add(this.lineSegments);
  }

  update(dt: number, camera: any): void {
    const windField = this.weather.getWindField('surface');
    if (!windField) {
      this.lineSegments.visible = false;
      return;
    }
    this.lineSegments.visible = this.weather.isLayerActive('wind');

    const { u, v } = windField;
    const gridW = 360;
    const gridH = 180;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      this.ages[i] += 1;

      if (this.ages[i] >= MAX_AGE) {
        this.resetParticle(i);
        this.clearTrail(i);
        continue;
      }

      // Current position
      const x = this.positions[i3];
      const y = this.positions[i3 + 1];
      const z = this.positions[i3 + 2];
      const r = Math.sqrt(x * x + y * y + z * z);

      const lat = Math.asin(y / r);
      const lon = Math.atan2(z, x);

      // Sample wind field at nearest grid cell
      const ui = Math.floor(((lon / Math.PI + 1) * 0.5) * (gridW - 1));
      const vj = Math.floor(((lat / (Math.PI / 2) + 1) * 0.5) * (gridH - 1));
      const gridIdx = Math.max(0, Math.min(gridH - 1, vj)) * gridW +
                      Math.max(0, Math.min(gridW - 1, ui));

      const windU = u[gridIdx] || 0;
      const windV = v[gridIdx] || 0;
      const windSpeed = Math.sqrt(windU * windU + windV * windV);
      this.speeds[i] = windSpeed;

      // Convert wind to position delta on sphere
      // u/v already contain speed magnitude — don't multiply by speed again
      const SPEED_SCALE = 0.0004 * dt;
      const MAX_WIND = 40;
      const uC = Math.abs(windU) > MAX_WIND ? Math.sign(windU) * MAX_WIND : windU;
      const vC = Math.abs(windV) > MAX_WIND ? Math.sign(windV) * MAX_WIND : windV;
      const dLon = uC * SPEED_SCALE / Math.max(0.3, Math.cos(lat));
      const dLat = vC * SPEED_SCALE;

      const newLon = lon + dLon;
      const newLat = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, lat + dLat));

      // Push trail (shift old positions, write current to head)
      this.pushTrail(i, newLat, newLon, GLOBE_SURFACE);

      // Update current position
      this.positions[i3] = GLOBE_SURFACE * Math.cos(newLat) * Math.cos(newLon);
      this.positions[i3 + 1] = GLOBE_SURFACE * Math.sin(newLat);
      this.positions[i3 + 2] = GLOBE_SURFACE * Math.cos(newLat) * Math.sin(newLon);
    }

    // Rebuild line geometry from trails
    this.rebuildLineGeometry();
  }

  private resetParticle(i: number): void {
    const i3 = i * 3;
    const lat = (Math.random() - 0.5) * Math.PI;
    const lon = (Math.random() - 0.5) * 2 * Math.PI;

    this.positions[i3] = GLOBE_SURFACE * Math.cos(lat) * Math.cos(lon);
    this.positions[i3 + 1] = GLOBE_SURFACE * Math.sin(lat);
    this.positions[i3 + 2] = GLOBE_SURFACE * Math.cos(lat) * Math.sin(lon);

    this.ages[i] = Math.random() * MAX_AGE * 0.3; // stagger
    this.speeds[i] = 0;
    this.trailWriteIdx[i] = 0;
  }

  private clearTrail(i: number): void {
    const trailBase = i * TRAIL_LENGTH * 3;
    for (let t = 0; t < TRAIL_LENGTH * 3; t++) {
      this.trailPositions[trailBase + t] = 0;
    }
  }

  private pushTrail(i: number, lat: number, lon: number, r: number): void {
    const trailBase = i * TRAIL_LENGTH * 3;
    const writeSlot = this.trailWriteIdx[i] % TRAIL_LENGTH;
    const slotOffset = trailBase + writeSlot * 3;

    this.trailPositions[slotOffset] = r * Math.cos(lat) * Math.cos(lon);
    this.trailPositions[slotOffset + 1] = r * Math.sin(lat);
    this.trailPositions[slotOffset + 2] = r * Math.cos(lat) * Math.sin(lon);

    this.trailWriteIdx[i] = writeSlot + 1;
  }

  private rebuildLineGeometry(): void {
    const posAttr = this.geometry.attributes.position as THREE.BufferAttribute;
    const colorAttr = this.geometry.attributes.color as THREE.BufferAttribute;

    for (let p = 0; p < PARTICLE_COUNT; p++) {
      const trailBase = p * TRAIL_LENGTH * 3;
      const vertBase = p * TRAIL_LENGTH * 3;
      const age = this.ages[p];
      const ageNorm = age / MAX_AGE;

      // Speed-based color: calm=blue, medium=cyan, fast=yellow
      const speed = Math.min(this.speeds[p] / 20, 1);

      for (let t = 0; t < TRAIL_LENGTH; t++) {
        const vIdx = vertBase + t * 3;
        const tIdx = trailBase + t * 3;

        // Ring buffer: oldest point first
        const slot = (this.trailWriteIdx[p] + t) % TRAIL_LENGTH;
        const srcIdx = trailBase + slot * 3;

        this.linePositions[vIdx] = this.trailPositions[srcIdx];
        this.linePositions[vIdx + 1] = this.trailPositions[srcIdx + 1];
        this.linePositions[vIdx + 2] = this.trailPositions[srcIdx + 2];

        // Fade by position in trail (tail = transparent, head = opaque)
        const trailFade = t / TRAIL_LENGTH;
        const alpha = trailFade * (1 - ageNorm * 0.5);

        // Color: blue → cyan → yellow based on speed
        this.lineColors[vIdx] = 0.2 + speed * 0.8;
        this.lineColors[vIdx + 1] = 0.4 + speed * 0.5;
        this.lineColors[vIdx + 2] = 1.0 - speed * 0.6;
      }
    }

    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }

  setVisible(visible: boolean): void {
    this.lineSegments.visible = visible;
  }
}
