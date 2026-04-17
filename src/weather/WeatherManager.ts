/**
 * WeatherManager — Central weather data pipeline.
 * Fetches, caches, interpolates, and distributes weather data to all consumers.
 */

import type { WeatherLevel, WeatherLayer, WeatherGrid, TimeRange } from './types';

const DEFAULT_LEVELS: WeatherLevel[] = ['surface', '850hPa', '500hPa', 'FL100', 'FL200', 'FL300'];
const DEFAULT_LAYERS: WeatherLayer[] = ['wind', 'temperature', 'pressure', 'humidity', 'clouds'];

export class WeatherManager {
  private grids: Map<string, WeatherGrid> = new Map();
  private currentTime: number = Date.now();
  private currentLevel: WeatherLevel = 'surface';
  private activeLayers: Set<WeatherLayer> = new Set(['wind', 'clouds']);
  private timeRange: TimeRange | null = null;

  // Event callbacks
  private listeners: Map<string, Set<Function>> = new Map();

  /**
   * Load initial weather data for the default view.
   */
  async loadInitial(): Promise<void> {
    // TODO: Fetch from backend proxy
    // For now, generate placeholder data
    this.grids.set('surface', this.generatePlaceholderGrid(360, 180));
    this.emit('dataLoaded', { level: 'surface' });
  }

  /**
   * Update per frame — handles interpolation, cache expiry, etc.
   */
  update(dt: number): void {
    // TODO: Smooth interpolation between forecast times
    // TODO: Pre-fetch adjacent time steps
  }

  /**
   * Get weather grid for a specific level.
   */
  getGrid(level: WeatherLevel): WeatherGrid | undefined {
    return this.grids.get(level);
  }

  /**
   * Get cloud coverage texture data for the current level/time.
   */
  getCloudCoverage(): Float32Array | null {
    const grid = this.grids.get(this.currentLevel);
    if (!grid) return null;

    // Extract cloud fraction from grid
    return grid.fields.cloudFraction ?? null;
  }

  /**
   * Get wind field (u, v components) for particle advection.
   */
  getWindField(level: WeatherLevel): { u: Float32Array; v: Float32Array } | null {
    const grid = this.grids.get(level);
    if (!grid) return null;

    if (!grid.fields.u || !grid.fields.v) return null;
    return { u: grid.fields.u, v: grid.fields.v };
  }

  /**
   * Set the current forecast time.
   */
  setTime(timestamp: number): void {
    this.currentTime = timestamp;
    this.emit('timeChange', { time: timestamp });
  }

  /**
   * Set the active vertical level.
   */
  setLevel(level: WeatherLevel): void {
    this.currentLevel = level;
    this.emit('levelChange', { level });
  }

  /**
   * Toggle a weather layer on/off.
   */
  toggleLayer(layer: WeatherLayer, active: boolean): void {
    if (active) {
      this.activeLayers.add(layer);
    } else {
      this.activeLayers.delete(layer);
    }
    this.emit('layerToggle', { layer, active });
  }

  /**
   * Check if a layer is active.
   */
  isLayerActive(layer: WeatherLayer): boolean {
    return this.activeLayers.has(layer);
  }

  // --- Event system ---

  on(event: string, fn: Function): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  off(event: string, fn: Function): void {
    this.listeners.get(event)?.delete(fn);
  }

  private emit(event: string, data?: any): void {
    this.listeners.get(event)?.forEach(fn => fn(data));
  }

  // --- Placeholder data generation ---

  private generatePlaceholderGrid(width: number, height: number): WeatherGrid {
    const size = width * height;

    // Generate smooth noise for cloud fraction
    const cloudFraction = new Float32Array(size);
    const u = new Float32Array(size);
    const v = new Float32Array(size);

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i;

        // Simple Perlin-ish noise
        const nx = i / width * 4;
        const ny = j / height * 4;
        const noise = (Math.sin(nx * 3.7 + ny * 2.3) * 0.5 + 0.5) *
                      (Math.cos(nx * 1.3 - ny * 4.1) * 0.5 + 0.5);

        cloudFraction[idx] = noise * 0.8;

        // Trade-wind-ish pattern
        const lat = (j / height - 0.5) * Math.PI;
        u[idx] = -Math.cos(lat * 2) * 15; // easterlies
        v[idx] = Math.sin(nx * 0.5) * 3; // slight meridional
      }
    }

    return {
      width,
      height,
      fields: { cloudFraction, u, v },
    };
  }
}
