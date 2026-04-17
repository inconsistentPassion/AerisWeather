/**
 * CloudRenderer — Ray-marched volumetric clouds driven by weather data.
 *
 * Architecture:
 *  - Render clouds at half resolution to offscreen buffer
 *  - Ray-march in fragment shader with 3D noise + weather coverage map
 *  - Integrate with Beer-Lambert transmittance + Henyey-Greenstein phase
 *  - Upscale with temporal accumulation (TAA)
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import { GLOBE_RADIUS } from '../scene/Globe';
import cloudVertexShader from '../shaders/cloud.vert';
import cloudFragmentShader from '../shaders/cloud.frag';
import { generatePerlinWorley3D } from '../utils/Noise3D';

export class CloudRenderer {
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private renderTarget: THREE.WebGLRenderTarget;
  private cloudMapTexture: THREE.DataTexture | null = null;

  private noiseTexture: THREE.Data3DTexture;

  constructor(scene: THREE.Scene, private weather: WeatherManager) {
    // Generate 3D noise texture (128³ Perlin-Worley FBM)
    this.noiseTexture = this.generateNoise3D(128);

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
        uPlanetRadius: { value: GLOBE_RADIUS },
        uCloudBase: { value: GLOBE_RADIUS * 1.002 },   // ~1.5 km
        uCloudTop: { value: GLOBE_RADIUS * 1.015 },     // ~10 km
        uTime: { value: 0 },
        uCameraPosition: { value: new THREE.Vector3() },
        uSunDirection: { value: new THREE.Vector3(0.6, 0.8, -0.4).normalize() },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.8) },
        uMaxSteps: { value: 48 },
        uLightSteps: { value: 8 },
        uDensityMultiplier: { value: 0.05 },
        uCoverageMultiplier: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Large sphere for the cloud shell
    const cloudRadius = GLOBE_RADIUS * 1.02;
    const geometry = new THREE.SphereGeometry(cloudRadius, 256, 256);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'clouds';
    scene.add(this.mesh);

    // Low-res render target for cloud pass
    this.renderTarget = new THREE.WebGLRenderTarget(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
      {
        format: THREE.RGBAFormat,
        type: THREE.FloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      }
    );

    // Listen for weather data changes
    this.weather.on('dataLoaded', () => this.updateCloudMap());
    this.weather.on('timeChange', () => this.updateCloudMap());
    this.weather.on('levelChange', () => this.updateCloudMap());
  }

  update(dt: number, camera: any): void {
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uCameraPosition.value.copy(camera.threeCamera.position);

    // Animate noise (slow drift)
    // TODO: offset noiseUV in shader by wind field
  }

  /**
   * Rebuild the cloud coverage texture from weather data.
   */
  private updateCloudMap(): void {
    const data = this.weather.getCloudCoverage();
    if (!data) return;

    if (this.cloudMapTexture) {
      // Update existing texture
      const texData = this.cloudMapTexture.image.data as unknown as Float32Array;
      for (let i = 0; i < data.length && i < texData.length / 4; i++) {
        texData[i * 4] = data[i];     // R = coverage
        texData[i * 4 + 1] = 0.5;     // G = humidity (placeholder)
        texData[i * 4 + 2] = 0.0;     // B = cloud type
        texData[i * 4 + 3] = 1.0;     // A = unused
      }
      this.cloudMapTexture.needsUpdate = true;
    }
  }

  private buildCloudMapTexture(): THREE.DataTexture {
    const width = 360;
    const height = 180;
    const data = new Float32Array(width * height * 4);

    // Fill with placeholder cloud data
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = (j * width + i) * 4;
        const nx = i / width * 4;
        const ny = j / height * 4;
        const noise = (Math.sin(nx * 3.7 + ny * 2.3) * 0.5 + 0.5) *
                      (Math.cos(nx * 1.3 - ny * 4.1) * 0.5 + 0.5);
        data[idx] = noise * 0.7;     // R = coverage
        data[idx + 1] = 0.5;         // G = humidity
        data[idx + 2] = 0.0;         // B = type
        data[idx + 3] = 1.0;         // A
      }
    }

    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Generate a 3D Perlin-Worley noise texture for volumetric clouds.
   */
  private generateNoise3D(size: number): THREE.Data3DTexture {
    const rawData = generatePerlinWorley3D(size);
    // Copy to ensure ArrayBuffer compatibility
    const data = new Float32Array(rawData);

    const texture = new THREE.Data3DTexture(data, size, size, size);
    texture.format = THREE.RedFormat;
    texture.type = THREE.FloatType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.wrapR = THREE.RepeatWrapping;
    texture.needsUpdate = true;

    return texture;
  }
}
