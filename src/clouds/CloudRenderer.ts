/**
 * CloudRenderer — Ray-marched volumetric clouds driven by weather data.
 *
 * v2 improvements:
 *  - Half-resolution render target with bilinear upscale
 *  - Wind-driven noise animation
 *  - Weather map integration (coverage + humidity + cloud type)
 *  - Adaptive density sampling for light march
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

  // Fullscreen quad for upscale pass
  private upscaleMaterial: THREE.ShaderMaterial;
  private upscaleQuad: THREE.Mesh;
  private upscaleScene: THREE.Scene;
  private upscaleCamera: THREE.OrthographicCamera;

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
        uWindVelocity: { value: new THREE.Vector2(0.0005, 0.0003) }, // drift direction
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    // Cloud shell geometry
    const cloudRadius = GLOBE_RADIUS * 1.02;
    const geometry = new THREE.SphereGeometry(cloudRadius, 256, 256);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'clouds';
    scene.add(this.mesh);

    // Half-res render target
    this.renderTarget = new THREE.WebGLRenderTarget(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
      {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      }
    );

    // Upscale pass (renders cloud RT to screen with bilinear filtering)
    this.upscaleScene = new THREE.Scene();
    this.upscaleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.upscaleMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uCloudTex;
        uniform vec2 uResolution;
        varying vec2 vUv;

        void main() {
          vec4 cloud = texture(uCloudTex, vUv);

          // Subtle sharpening to reduce blur from upscale
          // (very mild unsharp mask on alpha)
          vec2 texel = 1.0 / uResolution;
          float blur = 0.0;
          blur += texture(uCloudTex, vUv + vec2(texel.x, 0.0)).a;
          blur += texture(uCloudTex, vUv - vec2(texel.x, 0.0)).a;
          blur += texture(uCloudTex, vUv + vec2(0.0, texel.y)).a;
          blur += texture(uCloudTex, vUv - vec2(0.0, texel.y)).a;
          blur *= 0.25;

          float edgeBoost = clamp((cloud.a - blur) * 2.0 + 1.0, 0.8, 1.2);
          cloud.a = clamp(cloud.a * edgeBoost, 0.0, 1.0);

          gl_FragColor = cloud;
        }
      `,
      uniforms: {
        uCloudTex: { value: this.renderTarget.texture },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.upscaleQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.upscaleMaterial
    );
    this.upscaleScene.add(this.upscaleQuad);

    // Listen for weather data changes
    this.weather.on('dataLoaded', () => this.updateCloudMap());
    this.weather.on('timeChange', () => this.updateCloudMap());
    this.weather.on('levelChange', () => this.updateCloudMap());

    // Handle resize
    window.addEventListener('resize', () => this.onResize());
  }

  update(dt: number, camera: any): void {
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uCameraPosition.value.copy(camera.threeCamera.position);

    // Update wind from weather data (slow drift)
    const windField = this.weather.getWindField('surface');
    if (windField) {
      // Average global wind for noise drift
      const u = windField.u;
      const v = windField.v;
      let avgU = 0, avgV = 0;
      const step = Math.max(1, Math.floor(u.length / 1000));
      let count = 0;
      for (let i = 0; i < u.length; i += step) {
        avgU += u[i];
        avgV += v[i];
        count++;
      }
      avgU /= count;
      avgV /= count;
      this.material.uniforms.uWindVelocity.value.set(avgU * 0.0001, avgV * 0.0001);
    }
  }

  /**
   * Render clouds to half-res target, then upscale to screen.
   * Call this from the main render loop instead of relying on automatic rendering.
   */
  renderWithUpscale(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    // Save current render target
    const currentRT = renderer.getRenderTarget();

    // Render cloud sphere to half-res target
    renderer.setRenderTarget(this.renderTarget);
    renderer.clear();
    renderer.render(scene, camera);

    // Upscale to screen
    renderer.setRenderTarget(currentRT);
    renderer.render(this.upscaleScene, this.upscaleCamera);
  }

  private onResize(): void {
    const w = Math.floor(window.innerWidth / 2);
    const h = Math.floor(window.innerHeight / 2);
    this.renderTarget.setSize(w, h);
    this.upscaleMaterial.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
  }

  /**
   * Rebuild the cloud coverage texture from weather data.
   * Packs: R=coverage, G=humidity, B=cloudType, A=1
   */
  private updateCloudMap(): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    if (this.cloudMapTexture) {
      const texData = this.cloudMapTexture.image.data as unknown as Float32Array;
      const { width, height, fields } = grid;

      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const gridIdx = j * width + i;
          const texIdx = gridIdx * 4;

          texData[texIdx] = fields.cloudFraction?.[gridIdx] ?? 0;
          texData[texIdx + 1] = fields.humidity?.[gridIdx] ?? 0.5;
          texData[texIdx + 2] = 0.5; // cloud type (placeholder until weather data provides it)
          texData[texIdx + 3] = 1.0;
        }
      }
      this.cloudMapTexture.needsUpdate = true;
    }
  }

  private buildCloudMapTexture(): THREE.DataTexture {
    const width = 360;
    const height = 180;
    const data = new Float32Array(width * height * 4);

    // Fill with placeholder — will be replaced by weather data
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = (j * width + i) * 4;
        const nx = i / width * 4;
        const ny = j / height * 4;
        const noise = (Math.sin(nx * 3.7 + ny * 2.3) * 0.5 + 0.5) *
                      (Math.cos(nx * 1.3 - ny * 4.1) * 0.5 + 0.5);
        data[idx] = noise * 0.6;     // R = coverage
        data[idx + 1] = 0.6;         // G = humidity
        data[idx + 2] = 0.3;         // B = cloud type (0=stratus, 0.5=cumulus, 1=cirrus)
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
