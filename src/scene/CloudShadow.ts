/**
 * CloudShadow — Projects cloud shadows onto the globe surface.
 * Creates a subtle darkening effect where clouds are overhead.
 * Works with the weather cloud coverage data.
 */

import * as THREE from 'three';
import { GLOBE_RADIUS } from './Globe';
import type { WeatherManager } from '../weather/WeatherManager';

export class CloudShadow {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private cloudTexture: THREE.DataTexture | null = null;

  constructor(scene: THREE.Scene, private globe: THREE.Mesh, private weather: WeatherManager) {
    // Shadow shell slightly above globe surface
    const radius = GLOBE_RADIUS * 1.001;
    const geometry = new THREE.SphereGeometry(radius, 128, 64);

    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        varying vec2 vUv;

        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uCloudMap;
        uniform vec3 uSunDirection;
        uniform float uShadowIntensity;
        uniform float uTime;

        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        varying vec2 vUv;

        void main() {
          vec3 normal = normalize(vNormal);
          vec3 sunDir = normalize(uSunDirection);

          // Only cast shadow on the sunlit side
          float sunDot = dot(normal, sunDir);
          if (sunDot < 0.0) {
            discard;
          }

          // Sample cloud coverage
          // Offset UV by sun direction to cast shadow away from sun
          vec2 shadowUv = vUv;
          shadowUv.x += sunDir.x * 0.01; // subtle offset

          float coverage = texture(uCloudMap, shadowUv).r;

          // Shadow intensity varies with sun angle
          float sunAngle = smoothstep(0.0, 0.3, sunDot);
          float shadow = coverage * uShadowIntensity * sunAngle;

          // Soft edges
          shadow = smoothstep(0.0, 0.5, shadow);

          // Dark blue-gray shadow color
          vec3 shadowColor = vec3(0.02, 0.03, 0.05);

          gl_FragColor = vec4(shadowColor, shadow * 0.4);
        }
      `,
      uniforms: {
        uCloudMap: { value: null },
        uSunDirection: { value: new THREE.Vector3(1, 0.5, 0).normalize() },
        uShadowIntensity: { value: 1.0 },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.MultiplyBlending,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'cloudShadow';
    scene.add(this.mesh);
  }

  /**
   * Update cloud shadow with new cloud coverage data.
   */
  update(dt: number, sunDirection: THREE.Vector3): void {
    this.material.uniforms.uTime.value += dt;
    this.material.uniforms.uSunDirection.value.copy(sunDirection);

    // Get cloud coverage from weather manager
    const coverage = this.weather.getCloudCoverage();
    if (coverage) {
      if (!this.cloudTexture) {
        this.cloudTexture = this.createCloudTexture(coverage, 360, 180);
        this.material.uniforms.uCloudMap.value = this.cloudTexture;
      } else {
        this.updateCloudTexture(coverage);
      }
    }

    // Sync rotation with globe
    this.mesh.rotation.y = this.globe.rotation.y;
  }

  /**
   * Create a DataTexture from cloud coverage data.
   */
  private createCloudTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
    const pixels = new Uint8Array(width * height * 4);

    for (let i = 0; i < width * height; i++) {
      const val = Math.floor(Math.max(0, Math.min(1, data[i])) * 255);
      pixels[i * 4] = val;     // R = coverage
      pixels[i * 4 + 1] = val; // G = coverage
      pixels[i * 4 + 2] = val; // B = coverage
      pixels[i * 4 + 3] = 255;
    }

    const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
    texture.needsUpdate = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  /**
   * Update existing cloud texture with new data.
   */
  private updateCloudTexture(data: Float32Array): void {
    if (!this.cloudTexture) return;

    const pixels = this.cloudTexture.image.data as Uint8Array;
    const size = this.cloudTexture.image.width * this.cloudTexture.image.height;

    for (let i = 0; i < size && i < data.length; i++) {
      const val = Math.floor(Math.max(0, Math.min(1, data[i])) * 255);
      pixels[i * 4] = val;
      pixels[i * 4 + 1] = val;
      pixels[i * 4 + 2] = val;
    }

    this.cloudTexture.needsUpdate = true;
  }

  /**
   * Set shadow intensity (0-1).
   */
  setIntensity(intensity: number): void {
    this.material.uniforms.uShadowIntensity.value = intensity;
  }

  /**
   * Get the mesh for scene management.
   */
  getMesh(): THREE.Mesh {
    return this.mesh;
  }
}
