/**
 * CloudPointLayer — 3-layer cloud visualization using deck.gl.
 *
 * Renders GFS cloud cover data as point clouds at 3 altitude bands:
 *   Low:    ~0–3 km   (surface → 700 hPa) — white, dense
 *   Medium: ~3–7 km   (700 → 400 hPa)   — light grey
 *   High:   ~7–13 km  (above 400 hPa)   — wispy, blue-white
 *
 * Each layer's point density maps to the cloud fraction at that level.
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { WeatherManager } from '../weather/WeatherManager';
import type { DeckLayerManager } from './DeckLayerManager';
import type { CloudLayers } from '../weather/types';

// ── Config ────────────────────────────────────────────────────────────

const COVERAGE_THRESHOLD = 0.12;
const UPDATE_INTERVAL = 3000;

interface CloudLayerConfig {
  id: string;
  altitude: number;       // meters
  label: string;
  maxPoints: number;
  baseRadius: number;
  colorFn: (coverage: number) => [number, number, number, number];
}

const LAYER_CONFIGS: CloudLayerConfig[] = [
  {
    id: 'cloud-low',
    altitude: 1500,
    label: 'Low',
    maxPoints: 40000,
    baseRadius: 12000,
    colorFn: (c) => {
      // Warm white, dense
      const b = 230 - c * 40;
      return [b, b, Math.min(255, b + 8), (0.4 + c * 0.4) * 255 | 0];
    },
  },
  {
    id: 'cloud-mid',
    altitude: 5000,
    label: 'Medium',
    maxPoints: 30000,
    baseRadius: 15000,
    colorFn: (c) => {
      // Grey tones
      const b = 200 - c * 50;
      return [b, b, Math.min(255, b + 5), (0.3 + c * 0.35) * 255 | 0];
    },
  },
  {
    id: 'cloud-high',
    altitude: 9000,
    label: 'High',
    maxPoints: 20000,
    baseRadius: 18000,
    colorFn: (c) => {
      // Wispy blue-white
      const b = 210 - c * 30;
      return [b - 5, b, Math.min(255, b + 15), (0.2 + c * 0.3) * 255 | 0];
    },
  },
];

interface CloudPoint {
  longitude: number;
  latitude: number;
  altitude: number;
  coverage: number;
  radius: number;
}

export class CloudPointLayer {
  private weather: WeatherManager;
  private manager: DeckLayerManager;
  private visible = false;
  private dirty = true;
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  // Points per layer
  private layerPoints: CloudPoint[][] = [[], [], []];

  constructor(weather: WeatherManager, manager: DeckLayerManager) {
    this.weather = weather;
    this.manager = manager;

    this.weather.on('cloudLayersLoaded', () => { this.dirty = true; });
    this.weather.on('dataLoaded', () => { this.dirty = true; });
    this.weather.on('timeChange', () => { this.dirty = true; });

    this.updateTimer = setInterval(() => {
      if (this.visible && this.dirty) {
        this.rebuildPoints();
        this.flushLayers();
      }
    }, UPDATE_INTERVAL);
  }

  private rebuildPoints(): void {
    const layers = this.weather.getCloudLayers();
    if (!layers) {
      // Try from single grid
      const grid = this.weather.getGrid('surface');
      if (grid?.fields.cloudFraction) {
        this.rebuildFromSingleGrid(grid);
      }
      return;
    }

    const { width, height, low, medium, high } = layers;
    const coverageArrays = [low, medium, high];

    this.layerPoints = LAYER_CONFIGS.map((config, li) => {
      const coverage = coverageArrays[li];
      const points: CloudPoint[] = [];

      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const idx = j * width + i;
          const c = coverage[idx] / 100; // GFS is 0-100, normalize

          if (c < COVERAGE_THRESHOLD) continue;

          const lon = (i / width) * 360 - 180 + 0.5;
          const lat = 90 - (j / height) * 180 - 0.5;

          // Density: higher coverage = more points
          const numPoints = Math.max(1, Math.ceil(c * 2.5));
          for (let p = 0; p < numPoints; p++) {
            const jitterLon = (Math.random() - 0.5) * (360 / width) * 0.8;
            const jitterLat = (Math.random() - 0.5) * (180 / height) * 0.8;
            const altitudeJitter = config.altitude * (0.7 + Math.random() * 0.6);

            points.push({
              longitude: lon + jitterLon,
              latitude: Math.max(-85, Math.min(85, lat + jitterLat)),
              altitude: altitudeJitter,
              coverage: c,
              radius: config.baseRadius * (0.5 + c * 0.8) * (0.6 + Math.random() * 0.8),
            });

            if (points.length >= config.maxPoints) break;
          }
          if (points.length >= config.maxPoints) break;
        }
      }

      return points;
    });

    this.dirty = false;

    const total = this.layerPoints.reduce((s, p) => s + p.length, 0);
    if (total > 0) {
      console.log(`[Clouds] ${total} points: low=${this.layerPoints[0].length} mid=${this.layerPoints[1].length} high=${this.layerPoints[2].length}`);
    }
  }

  /**
   * Fallback: generate cloud layers from a single total cloud fraction grid.
   */
  private rebuildFromSingleGrid(grid: any): void {
    const { width, height, fields } = grid;
    const cloudFraction = fields.cloudFraction;
    if (!cloudFraction) return;

    this.layerPoints = LAYER_CONFIGS.map((config, li) => {
      const points: CloudPoint[] = [];

      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const idx = j * width + i;
          let c = cloudFraction[idx];

          // Distribute coverage across layers
          if (li === 0) c *= 0.5;      // low gets half
          else if (li === 1) c *= 0.3;  // mid gets 30%
          else c *= 0.2;                 // high gets 20%

          if (c < COVERAGE_THRESHOLD) continue;

          const lon = (i / width) * 360 - 180 + 0.5;
          const lat = 90 - (j / height) * 180 - 0.5;
          const numPoints = Math.max(1, Math.ceil(c * 2));

          for (let p = 0; p < numPoints; p++) {
            const jitterLon = (Math.random() - 0.5) * (360 / width) * 0.8;
            const jitterLat = (Math.random() - 0.5) * (180 / height) * 0.8;

            points.push({
              longitude: lon + jitterLon,
              latitude: Math.max(-85, Math.min(85, lat + jitterLat)),
              altitude: config.altitude * (0.7 + Math.random() * 0.6),
              coverage: c,
              radius: config.baseRadius * (0.5 + c * 0.8) * (0.6 + Math.random() * 0.8),
            });

            if (points.length >= config.maxPoints) break;
          }
          if (points.length >= config.maxPoints) break;
        }
      }

      return points;
    });

    this.dirty = false;
  }

  private flushLayers(): void {
    LAYER_CONFIGS.forEach((config, i) => {
      if (!this.visible || this.layerPoints[i].length === 0) {
        this.manager.removeLayer(config.id);
        return;
      }

      this.manager.setLayer(config.id, new ScatterplotLayer<CloudPoint>({
        id: config.id,
        data: this.layerPoints[i],
        pickable: false,
        opacity: 1,
        stroked: false,
        filled: true,
        radiusScale: 1,
        radiusMinPixels: 1,
        radiusMaxPixels: 50,
        getPosition: d => [d.longitude, d.latitude, d.altitude],
        getRadius: d => d.radius,
        getFillColor: d => config.colorFn(d.coverage),
        billboard: true,
      }));
    });
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v && this.dirty) this.rebuildPoints();
    this.flushLayers();
  }

  destroy(): void {
    if (this.updateTimer) clearInterval(this.updateTimer);
    LAYER_CONFIGS.forEach(c => this.manager.removeLayer(c.id));
  }
}
