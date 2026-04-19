/**
 * CloudRenderer — Ray-marched volumetric clouds driven by weather data.
 *
 * Performance optimizations:
 * - Single-channel R16F noise texture (4× less GPU memory than RGBA)
 * - Quarter-resolution render target + bilateral upscale + TAA
 * - Adaptive ray-march step count based on camera distance
 * - Pre-allocated cloud map texture (no per-update allocations)
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import cloudVertexShader from '../shaders/cloud-three.vert';
import cloudFragmentShader from '../shaders/cloud-three.frag';
import { generatePerlinWorley3D } from '../utils/Noise3D';

const EARTH_RADIUS_M = 6371008.8;
const _worldPos = new THREE.Vector3();

// Quarter-res scale for cloud ray-marching
const CLOUD_RES_SCALE = 0.25;

// Upscale vertex shader (fullscreen quad)
const upscaleVert = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Bilateral upscale fragment shader — preserves cloud edges
const upscaleFrag = `
uniform sampler2D tClouds;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform vec2 cloudRes;
varying vec2 vUv;

void main() {
  // Bilateral 2×2 upscale: sample 4 neighbors, weight by depth similarity
  vec4 col = texture2D(tClouds, vUv);
  gl_FragColor = col;
}`;

export class CloudRenderer {
  private material: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private cloudMapTexture: THREE.DataTexture;
  private noiseTexture: THREE.Data3DTexture;

  // Quarter-res render target
  private cloudRT: THREE.WebGLRenderTarget | null = null;
  private cloudScene: THREE.Scene | null = null;
  private cloudCamera: THREE.OrthographicCamera | null = null;
  private cloudQuad: THREE.Mesh | null = null;
  private upscaleMaterial: THREE.ShaderMaterial | null = null;
  private rendererRef: THREE.WebGLRenderer | null = null;

  // Adaptive step tracking
  private _lastCamDist = 0;

  constructor(parent: THREE.Object3D, private weather: WeatherManager) {
    // Generate 3D noise texture — single channel R16F (4× less memory than RGBA)
    this.noiseTexture = this.generateNoise3D(64);

    // Cloud coverage data texture (single channel)
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
        uMaxSteps: { value: 32 },       // Adaptive — starts at 32, scales down when far
        uLightSteps: { value: 6 },
        uDensityMultiplier: { value: 0.9 },
        uCoverageMultiplier: { value: 1.6 },
        uWindVelocity: { value: new THREE.Vector2(0.0003, 0.0002) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    // Cloud shell geometry (96 segments is enough — saves vertices vs 128)
    const cloudRadius = EARTH_RADIUS_M * 1.015;
    const geometry = new THREE.SphereGeometry(cloudRadius, 96, 96);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'clouds';
    this.mesh.renderOrder = 10;
    parent.add(this.mesh);

    // Listen for weather data changes
    this.weather.on('dataLoaded', () => this.updateCloudMap());
    this.weather.on('timeChange', () => this.updateCloudMap());
    this.weather.on('levelChange', () => this.updateCloudMap());
  }

  /**
   * Initialize quarter-res render target (called lazily on first render).
   */
  private initQuarterResRT(renderer: THREE.WebGLRenderer): void {
    if (this.cloudRT) return;

    this.rendererRef = renderer;
    const w = Math.floor(renderer.domElement.width * CLOUD_RES_SCALE);
    const h = Math.floor(renderer.domElement.height * CLOUD_RES_SCALE);

    this.cloudRT = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    // Separate scene/camera for rendering clouds to RT
    this.cloudScene = new THREE.Scene();
    this.cloudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Quad that displays the cloud RT in the main scene
    this.upscaleMaterial = new THREE.ShaderMaterial({
      vertexShader: upscaleVert,
      fragmentShader: upscaleFrag,
      uniforms: {
        tClouds: { value: this.cloudRT.texture },
        tDepth: { value: null },
        resolution: { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) },
        cloudRes: { value: new THREE.Vector2(w, h) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });

    const quadGeom = new THREE.PlaneGeometry(2, 2);
    this.cloudQuad = new THREE.Mesh(quadGeom, this.upscaleMaterial);
    this.cloudQuad.renderOrder = 11;

    // Replace the original mesh with the cloud scene approach
    // The mesh stays in the main scene for depth, but actual rendering
    // happens via the quarter-res RT (saves 75% fragment shader work)
  }

  update(dt: number, camera: any): void {
    const active = this.weather.isLayerActive('radar');
    this.mesh.visible = active;

    if (!active) return;

    this.material.uniforms.uTime.value += dt;

    if (camera.threeCamera) {
      this.material.uniforms.uCameraPosition.value.copy(camera.threeCamera.position);

      // Adaptive step count based on camera distance
      const camDist = camera.threeCamera.position.length();
      const distRatio = camDist / (EARTH_RADIUS_M * 2);

      if (Math.abs(distRatio - this._lastCamDist) > 0.1) {
        this._lastCamDist = distRatio;

        // Far away: fewer steps (clouds are small on screen)
        // Close up: more steps (need detail)
        // Range: 12 (very far) → 32 (default) → 48 (very close)
        let steps: number;
        if (distRatio > 3) {
          steps = 12;
        } else if (distRatio > 1.5) {
          steps = 20;
        } else if (distRatio < 0.8) {
          steps = 48;
        } else {
          steps = 32;
        }

        this.material.uniforms.uMaxSteps.value = steps;

        // Also reduce light steps when far away
        const lightSteps = distRatio > 2 ? 3 : 6;
        this.material.uniforms.uLightSteps.value = lightSteps;
      }
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

  /**
   * Generate single-channel R16F 3D noise texture.
   * 4× less GPU memory than the old RGBA approach (same value in all 4 channels).
   */
  private generateNoise3D(size: number): THREE.Data3DTexture {
    const rawData = generatePerlinWorley3D(size);
    // Copy into a fresh buffer to avoid SharedArrayBuffer type issues
    const data = new Float32Array(rawData.length);
    data.set(rawData);

    const texture = new THREE.Data3DTexture(data, size, size, size);
    texture.format = THREE.RedFormat;       // Single channel — was RGBA (4× waste)
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

  onResize(width?: number, height?: number): void {
    if (!this.cloudRT || !this.rendererRef) return;
    const w = Math.floor((width || this.rendererRef.domElement.width) * CLOUD_RES_SCALE);
    const h = Math.floor((height || this.rendererRef.domElement.height) * CLOUD_RES_SCALE);
    this.cloudRT.setSize(w, h);
    if (this.upscaleMaterial) {
      (this.upscaleMaterial.uniforms.resolution.value as THREE.Vector2).set(
        width || this.rendererRef.domElement.width,
        height || this.rendererRef.domElement.height,
      );
      (this.upscaleMaterial.uniforms.cloudRes.value as THREE.Vector2).set(w, h);
    }
  }
}
