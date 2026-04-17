/**
 * WeatherOverlay — Colored 2D overlays for temperature, pressure, humidity.
 * 
 * Projects weather data as a transparent color map onto the globe surface.
 * Each layer type has its own color ramp.
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import type { WeatherLayer } from '../weather/types';
import { GLOBE_RADIUS } from '../scene/Globe';

// Color ramps for each layer type
const COLOR_RAMPS: Record<string, (t: number) => [number, number, number]> = {
  temperature: (t: number) => {
    // Blue (cold) → White → Red (hot)
    if (t < 0.3) {
      const s = t / 0.3;
      return [0, s * 0.5, 0.5 + s * 0.5];
    } else if (t < 0.5) {
      const s = (t - 0.3) / 0.2;
      return [s, 0.5 + s * 0.5, 1.0 - s * 0.5];
    } else if (t < 0.7) {
      const s = (t - 0.5) / 0.2;
      return [1.0, 1.0 - s * 0.3, 0.5 - s * 0.3];
    } else {
      const s = (t - 0.7) / 0.3;
      return [1.0, 0.7 - s * 0.7, 0.2 - s * 0.2];
    }
  },

  pressure: (t: number) => {
    // Purple (low) → Blue → Green → Yellow (high)
    if (t < 0.25) {
      const s = t / 0.25;
      return [0.5 - s * 0.3, s * 0.3, 0.5 + s * 0.3];
    } else if (t < 0.5) {
      const s = (t - 0.25) / 0.25;
      return [0.2 - s * 0.2, 0.3 + s * 0.4, 0.8 - s * 0.3];
    } else if (t < 0.75) {
      const s = (t - 0.5) / 0.25;
      return [s * 0.8, 0.7 + s * 0.3, 0.5 - s * 0.5];
    } else {
      const s = (t - 0.75) / 0.25;
      return [0.8 + s * 0.2, 1.0, s * 0.2];
    }
  },

  humidity: (t: number) => {
    // Brown (dry) → Green → Blue (wet)
    if (t < 0.4) {
      const s = t / 0.4;
      return [0.6 - s * 0.4, 0.3 + s * 0.4, 0.1 + s * 0.2];
    } else if (t < 0.7) {
      const s = (t - 0.4) / 0.3;
      return [0.2 - s * 0.15, 0.7, 0.3 + s * 0.3];
    } else {
      const s = (t - 0.7) / 0.3;
      return [0.05 - s * 0.05, 0.7 - s * 0.3, 0.6 + s * 0.4];
    }
  },
};

export class WeatherOverlay {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private dataTexture: THREE.DataTexture;
  private currentLayer: WeatherLayer | null = null;
  private visible: boolean = false;

  constructor(scene: THREE.Scene, private weather: WeatherManager) {
    // Create the data texture (360x180 lat-lon grid)
    const data = new Float32Array(360 * 180 * 4);
    this.dataTexture = new THREE.DataTexture(data, 360, 180, THREE.RGBAFormat, THREE.FloatType);
    this.dataTexture.wrapS = THREE.RepeatWrapping;
    this.dataTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.dataTexture.needsUpdate = true;

    // Shader material
    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uData;
        uniform float uOpacity;
        uniform int uColorMode; // 0=temperature, 1=pressure, 2=humidity
        varying vec2 vUv;
        varying vec3 vWorldPosition;

        vec3 tempRamp(float t) {
          if (t < 0.3) return vec3(0.0, t/0.3*0.5, 0.5+t/0.3*0.5);
          if (t < 0.5) { float s=(t-0.3)/0.2; return vec3(s, 0.5+s*0.5, 1.0-s*0.5); }
          if (t < 0.7) { float s=(t-0.5)/0.2; return vec3(1.0, 1.0-s*0.3, 0.5-s*0.3); }
          float s=(t-0.7)/0.3; return vec3(1.0, 0.7-s*0.7, 0.2-s*0.2);
        }

        vec3 pressureRamp(float t) {
          if (t < 0.25) { float s=t/0.25; return vec3(0.5-s*0.3, s*0.3, 0.5+s*0.3); }
          if (t < 0.5) { float s=(t-0.25)/0.25; return vec3(0.2-s*0.2, 0.3+s*0.4, 0.8-s*0.3); }
          if (t < 0.75) { float s=(t-0.5)/0.25; return vec3(s*0.8, 0.7+s*0.3, 0.5-s*0.5); }
          float s=(t-0.75)/0.25; return vec3(0.8+s*0.2, 1.0, s*0.2);
        }

        vec3 humidityRamp(float t) {
          if (t < 0.4) { float s=t/0.4; return vec3(0.6-s*0.4, 0.3+s*0.4, 0.1+s*0.2); }
          if (t < 0.7) { float s=(t-0.4)/0.3; return vec3(0.2-s*0.15, 0.7, 0.3+s*0.3); }
          float s=(t-0.7)/0.3; return vec3(0.05-s*0.05, 0.7-s*0.3, 0.6+s*0.4);
        }

        void main() {
          vec4 raw = texture(uData, vUv);
          float value = raw.r;

          vec3 color;
          if (uColorMode == 0) color = tempRamp(value);
          else if (uColorMode == 1) color = pressureRamp(value);
          else color = humidityRamp(value);

          // Only show where data is meaningful
          float alpha = smoothstep(0.05, 0.15, value) * uOpacity;

          gl_FragColor = vec4(color, alpha);
        }
      `,
      uniforms: {
        uData: { value: this.dataTexture },
        uOpacity: { value: 0.4 },
        uColorMode: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    // Slightly larger than globe to avoid z-fighting
    const overlayRadius = GLOBE_RADIUS * 1.0005;
    const geometry = new THREE.SphereGeometry(overlayRadius, 128, 128);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'weatherOverlay';
    this.mesh.visible = false;
    scene.add(this.mesh);

    // Listen for layer changes
    this.weather.on('layerToggle', ({ layer, active }: any) => {
      this.handleLayerToggle(layer, active);
    });
  }

  private handleLayerToggle(layer: WeatherLayer, active: boolean): void {
    const colorModeMap: Record<string, number> = {
      temperature: 0,
      pressure: 1,
      humidity: 2,
    };

    if (active && colorModeMap[layer] !== undefined) {
      this.currentLayer = layer;
      this.material.uniforms.uColorMode.value = colorModeMap[layer];
      this.mesh.visible = true;
      this.updateDataTexture();
    } else if (layer === this.currentLayer && !active) {
      this.currentLayer = null;
      this.mesh.visible = false;
    }
  }

  private updateDataTexture(): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    const { width, height, fields } = grid;
    const texData = this.dataTexture.image.data as unknown as Float32Array;

    let sourceData: Float32Array | undefined;

    switch (this.currentLayer) {
      case 'temperature':
        sourceData = fields.temperature;
        break;
      case 'humidity':
        sourceData = fields.humidity;
        break;
      case 'pressure':
        // Use cloud fraction as proxy for pressure
        sourceData = fields.cloudFraction;
        break;
      default:
        return;
    }

    if (!sourceData) return;

    // Normalize and pack into RGBA
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < sourceData.length; i++) {
      min = Math.min(min, sourceData[i]);
      max = Math.max(max, sourceData[i]);
    }
    const range = max - min || 1;

    for (let i = 0; i < sourceData.length; i++) {
      const normalized = (sourceData[i] - min) / range;
      texData[i * 4] = normalized;
      texData[i * 4 + 1] = 0;
      texData[i * 4 + 2] = 0;
      texData[i * 4 + 3] = 1;
    }

    this.dataTexture.needsUpdate = true;
  }
}
