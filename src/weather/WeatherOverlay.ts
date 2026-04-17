/**
 * WeatherOverlay — Colored overlays for temperature, pressure, humidity.
 * 
 * Simplified: renders a separate sphere per active layer type.
 * Each layer has its own material, toggled by the UI.
 */

import * as THREE from 'three';
import type { WeatherManager } from '../weather/WeatherManager';
import type { WeatherLayer } from '../weather/types';
import { GLOBE_RADIUS } from '../scene/Globe';

interface LayerConfig {
  colorMode: number;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  texture: THREE.DataTexture;
}

export class WeatherOverlay {
  private layers: Map<WeatherLayer, LayerConfig> = new Map();
  private activeLayer: WeatherLayer | null = null;

  constructor(parent: THREE.Object3D, private weather: WeatherManager) {
    // Create one sphere + material per overlay type
    const layerDefs: Array<{ name: WeatherLayer; mode: number }> = [
      { name: 'temperature', mode: 0 },
      { name: 'pressure', mode: 1 },
      { name: 'humidity', mode: 2 },
    ];

    for (const def of layerDefs) {
      const config = this.createLayer(def.name, def.mode);
      parent.add(config.mesh);
      this.layers.set(def.name, config);
    }

    // Listen for layer toggle events
    this.weather.on('layerToggle', ({ layer, active }: any) => {
      this.onLayerToggle(layer, active);
    });
  }

  private createLayer(name: WeatherLayer, colorMode: number): LayerConfig {
    // Data texture (360x180)
    const data = new Float32Array(360 * 180 * 4);
    const texture = new THREE.DataTexture(data, 360, 180, THREE.RGBAFormat, THREE.FloatType);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    const material = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uData;
        uniform int uColorMode;
        varying vec2 vUv;

        vec3 tempColor(float t) {
          // Cold blue → white → hot red
          if (t < 0.5) return mix(vec3(0.1, 0.2, 0.8), vec3(1.0, 1.0, 1.0), t * 2.0);
          return mix(vec3(1.0, 1.0, 1.0), vec3(0.9, 0.15, 0.05), (t - 0.5) * 2.0);
        }
        vec3 pressureColor(float t) {
          // Low purple → mid green → high yellow
          if (t < 0.33) return mix(vec3(0.4, 0.1, 0.6), vec3(0.1, 0.4, 0.8), t * 3.0);
          if (t < 0.66) return mix(vec3(0.1, 0.4, 0.8), vec3(0.2, 0.8, 0.3), (t - 0.33) * 3.0);
          return mix(vec3(0.2, 0.8, 0.3), vec3(1.0, 0.9, 0.2), (t - 0.66) * 3.0);
        }
        vec3 humidityColor(float t) {
          // Dry brown → green → wet blue
          if (t < 0.5) return mix(vec3(0.6, 0.4, 0.2), vec3(0.2, 0.7, 0.3), t * 2.0);
          return mix(vec3(0.2, 0.7, 0.3), vec3(0.1, 0.3, 0.9), (t - 0.5) * 2.0);
        }

        void main() {
          float value = texture(uData, vUv).r;
          
          vec3 color;
          if (uColorMode == 0) color = tempColor(value);
          else if (uColorMode == 1) color = pressureColor(value);
          else color = humidityColor(value);

          // Semi-transparent overlay
          float alpha = 0.35;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      uniforms: {
        uData: { value: texture },
        uColorMode: { value: colorMode },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    // Sphere slightly above globe surface
    const radius = GLOBE_RADIUS * 1.001;
    const geometry = new THREE.SphereGeometry(radius, 128, 128);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `overlay_${name}`;
    mesh.visible = false;
    mesh.renderOrder = 5; // above globe, below clouds

    return { colorMode, mesh, material, texture };
  }

  private onLayerToggle(layer: WeatherLayer, active: boolean): void {
    // Hide all overlay layers first
    this.layers.forEach((config) => {
      config.mesh.visible = false;
    });

    if (active && this.layers.has(layer)) {
      this.activeLayer = layer;
      const config = this.layers.get(layer)!;
      config.mesh.visible = true;
      this.updateTexture(config, layer);
    } else {
      this.activeLayer = null;
    }
  }

  private updateTexture(config: LayerConfig, layer: WeatherLayer): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    const { width, height, fields } = grid;
    const texData = config.texture.image.data as unknown as Float32Array;

    let source: Float32Array | undefined;
    switch (layer) {
      case 'temperature': source = fields.temperature; break;
      case 'humidity': source = fields.humidity; break;
      case 'pressure': source = fields.cloudFraction; break; // proxy
    }
    if (!source) return;

    // Normalize to 0-1
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < source.length; i++) {
      if (source[i] < min) min = source[i];
      if (source[i] > max) max = source[i];
    }
    const range = max - min || 1;

    for (let i = 0; i < source.length; i++) {
      texData[i * 4] = (source[i] - min) / range;
      texData[i * 4 + 1] = 0;
      texData[i * 4 + 2] = 0;
      texData[i * 4 + 3] = 1;
    }

    config.texture.needsUpdate = true;
  }

  /**
   * Set visibility of a specific overlay layer.
   */
  setVisible(layer: WeatherLayer, active: boolean): void {
    this.onLayerToggle(layer, active);
  }

  /**
   * Update per frame — only updates texture when an overlay is visible.
   */
  update(dt: number): void {
    if (this.activeLayer && this.layers.has(this.activeLayer)) {
      this.updateTexture(this.layers.get(this.activeLayer)!, this.activeLayer);
    }
  }
}
