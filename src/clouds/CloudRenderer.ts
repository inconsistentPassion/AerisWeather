/**
 * CloudRenderer — Ray-marched volumetric clouds driven by weather data.
 *
 * Enhanced version with:
 * - Multi-octave noise (3 octaves for finer detail)
 * - Better height falloff for realistic cloud shapes
 * - Improved silver lining and ambient lighting
 * - Proper weather data integration
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import cloudVertexShader from '../shaders/cloud-three.vert';
import cloudFragmentShader from '../shaders/cloud-three.frag';
import { generatePerlinWorley3D } from '../utils/Noise3D';

const EARTH_RADIUS_M = 6371008.8;
const _worldPos = new THREE.Vector3();

export class CloudRenderer {
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private cloudMapTexture: THREE.DataTexture;
  private noiseTexture: THREE.Data3DTexture;

  constructor(parent: THREE.Object3D, private weather: WeatherManager) {
    // Generate 3D noise texture (64³ for speed, RGBA for compatibility)
    this.noiseTexture = this.generateNoise3D(64);

    // Cloud coverage data texture
    this.cloudMapTexture = this.buildCloudMapTexture();

    // Shader material for cloud volume
    this.material = new THREE.ShaderMaterial({
      vertexShader: cloudVertexShader,
      fragmentShader: cloudFragmentShader,
      uniforms: {
        uCloudMap: { value: this.cloudMapTexture },
        uNoiseTex: { value: this.noiseTexture },
        uPlanetCenter: { value: new THREE.Vector3(0, 0, 0) },
        uPlanetRadius: { value: EARTH_RADIUS_M },
        uCloudBase: { value: EARTH_RADIUS_M * 1.002 },
        uCloudTop: { value: EARTH_RADIUS_M * 1.012 },
        uTime: { value: 0 },
        uCameraPosition: { value: new THREE.Vector3() },
        uSunDirection: { value: new THREE.Vector3(0.6, 0.8, -0.4).normalize() },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.8) },
        uMaxSteps: { value: 40 },       // More steps for smoother clouds
        uLightSteps: { value: 6 },       // More light steps for better shadows
        uDensityMultiplier: { value: 0.9 },
        uCoverageMultiplier: { value: 1.6 },
        uWindVelocity: { value: new THREE.Vector2(0.0003, 0.0002) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    // Cloud shell geometry
    const cloudRadius = EARTH_RADIUS_M * 1.015;
    const geometry = new THREE.SphereGeometry(cloudRadius, 128, 128);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'clouds';
    this.mesh.renderOrder = 10;
    parent.add(this.mesh);

    // Listen for weather data changes
    this.weather.on('dataLoaded', () => this.updateCloudMap());
    this.weather.on('timeChange', () => this.updateCloudMap());
    this.weather.on('levelChange', () => this.updateCloudMap());
  }

  update(dt: number, camera: any): void {
    const active = this.weather.isLayerActive('radar');
    this.mesh.visible = active;

    if (!active) return;

    this.material.uniforms.uTime.value += dt;

    if (camera.threeCamera) {
      this.material.uniforms.uCameraPosition.value.copy(camera.threeCamera.position);
    }

    this.mesh.getWorldPosition(_worldPos);
    this.material.uniforms.uPlanetCenter.value.copy(_worldPos);

    // Wind drift
    this.material.uniforms.uWindVelocity.value.set(0.0003, 0.0002);
  }

  private updateCloudMap(): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    const texData = this.cloudMapTexture.image.data as unknown as Float32Array;
    const { width, height, fields } = grid;

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const gridIdx = j * width + i;
        const texIdx = gridIdx * 4;

        texData[texIdx] = fields.cloudFraction?.[gridIdx] ?? 0;
        texData[texIdx + 1] = fields.humidity?.[gridIdx] ?? 0.5;
        texData[texIdx + 2] = 0.5;
        texData[texIdx + 3] = 1.0;
      }
    }
    this.cloudMapTexture.needsUpdate = true;
  }

  private buildCloudMapTexture(): THREE.DataTexture {
    const width = 360;
    const height = 180;
    const data = new Float32Array(width * height * 4);

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = (j * width + i) * 4;
        const lat = (j / height - 0.5) * Math.PI;

        const itcz = Math.exp(-lat * lat * 15) * 0.7;
        const storm = Math.exp(-Math.pow(Math.abs(lat) - 0.8, 2) * 10) * 0.5;
        const nx = i / width * 6;
        const ny = j / height * 6;
        const noise = (Math.sin(nx * 2.1 + ny * 1.7) * 0.5 + 0.5) *
                      (Math.cos(nx * 1.3 - ny * 2.3) * 0.5 + 0.5);

        const coverage = Math.min(1.0, itcz + storm + noise * 0.3);

        data[idx] = coverage;
        data[idx + 1] = 0.7;
        data[idx + 2] = 0.4;
        data[idx + 3] = 1.0;
      }
    }

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  private generateNoise3D(size: number): THREE.Data3DTexture {
    const rawData = generatePerlinWorley3D(size);
    const data = new Float32Array(size * size * size * 4);
    for (let i = 0; i < rawData.length; i++) {
      const i4 = i * 4;
      data[i4] = rawData[i];
      data[i4 + 1] = rawData[i];
      data[i4 + 2] = rawData[i];
      data[i4 + 3] = 1.0;
    }

    const texture = new THREE.Data3DTexture(data, size, size, size);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.FloatType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.wrapR = THREE.RepeatWrapping;
    texture.needsUpdate = true;

    return texture;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  onResize(): void {
    // No-op for simplified renderer
  }
}
