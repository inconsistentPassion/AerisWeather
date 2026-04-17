/**
 * WeatherManager — Central weather data pipeline.
 * Fetches from backend proxy, caches, interpolates, distributes to consumers.
 * 
 * v2: Integrates with AgentA's realistic weather generation via API.
 */

import type { WeatherLevel, WeatherLayer, WeatherGrid, TimeRange } from './types';

const DEFAULT_LEVELS: WeatherLevel[] = ['surface', '850hPa', '500hPa', 'FL100', 'FL200', 'FL300'];
const DEFAULT_LAYERS: WeatherLayer[] = ['wind', 'temperature', 'pressure', 'humidity', 'clouds'];
const API_BASE = 'http://localhost:3001';

export class WeatherManager {
  private grids: Map<string, WeatherGrid> = new Map();
  private currentTime: number = Date.now();
  private currentLevel: WeatherLevel = 'surface';
  private activeLayers: Set<WeatherLayer> = new Set(['wind', 'clouds']);
  private timeRange: TimeRange | null = null;
  private fetchInterval: ReturnType<typeof setInterval> | null = null;

  // Event callbacks
  private listeners: Map<string, Set<Function>> = new Map();

  /**
   * Load initial weather data for the default view.
   */
  async loadInitial(): Promise<void> {
    // Try to fetch from backend first
    try {
      const grid = await this.fetchGrid('surface', this.currentTime);
      if (grid) {
        this.grids.set('surface', grid);
        this.emit('dataLoaded', { level: 'surface' });
        return;
      }
    } catch (e) {
      // Backend not available, fall back to local generation
    }

    // Fallback: generate locally
    this.grids.set('surface', this.generatePlaceholderGrid(360, 180));
    this.emit('dataLoaded', { level: 'surface' });
  }

  /**
   * Fetch weather grid from backend API.
   */
  private async fetchGrid(level: string, time: number): Promise<WeatherGrid | null> {
    try {
      const timeStr = new Date(time).toISOString();
      const res = await fetch(`${API_BASE}/api/weather/grid?level=${level}&time=${timeStr}`);
      if (!res.ok) return null;

      const data = await res.json();
      if (!data.grid) return null;

      return this.parseApiGrid(data.grid);
    } catch {
      return null;
    }
  }

  /**
   * Parse API response into WeatherGrid format.
   */
  private parseApiGrid(apiGrid: any): WeatherGrid {
    return {
      width: apiGrid.width,
      height: apiGrid.height,
      fields: {
        cloudFraction: apiGrid.fields?.cloudFraction
          ? new Float32Array(apiGrid.fields.cloudFraction)
          : undefined,
        humidity: apiGrid.fields?.humidity
          ? new Float32Array(apiGrid.fields.humidity)
          : undefined,
        temperature: apiGrid.fields?.temperature
          ? new Float32Array(apiGrid.fields.temperature)
          : undefined,
        u: apiGrid.fields?.u
          ? new Float32Array(apiGrid.fields.u)
          : undefined,
        v: apiGrid.fields?.v
          ? new Float32Array(apiGrid.fields.v)
          : undefined,
        w: apiGrid.fields?.w
          ? new Float32Array(apiGrid.fields.w)
          : undefined,
      },
    };
  }

  /**
   * Update per frame — handles interpolation, pre-fetching, etc.
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
   * Set the current forecast time. Fetches new data if needed.
   */
  async setTime(timestamp: number): Promise<void> {
    this.currentTime = timestamp;
    this.emit('timeChange', { time: timestamp });

    // Fetch new data for the changed time
    try {
      const grid = await this.fetchGrid(this.currentLevel, timestamp);
      if (grid) {
        this.grids.set(this.currentLevel, grid);
        this.emit('dataLoaded', { level: this.currentLevel });
      }
    } catch {
      // Silently fail, use cached data
    }
  }

  /**
   * Set the active vertical level. Fetches if not cached.
   */
  async setLevel(level: WeatherLevel): Promise<void> {
    this.currentLevel = level;
    this.emit('levelChange', { level });

    // Fetch if we don't have this level
    if (!this.grids.has(level)) {
      try {
        const grid = await this.fetchGrid(level, this.currentTime);
        if (grid) {
          this.grids.set(level, grid);
          this.emit('dataLoaded', { level });
        }
      } catch {
        // Use placeholder
        this.grids.set(level, this.generatePlaceholderGrid(360, 180));
        this.emit('dataLoaded', { level });
      }
    }
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

  // --- Placeholder data generation (fallback) ---

  private generatePlaceholderGrid(width: number, height: number): WeatherGrid {
    const size = width * height;
    const cloudFraction = new Float32Array(size);
    const humidity = new Float32Array(size);
    const u = new Float32Array(size);
    const v = new Float32Array(size);

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i;
        const lat = (j / height - 0.5) * 180;

        const nx = i / width * 4;
        const ny = j / height * 4;
        const noise = (Math.sin(nx * 3.7 + ny * 2.3) * 0.5 + 0.5) *
                      (Math.cos(nx * 1.3 - ny * 4.1) * 0.5 + 0.5);

        // ITCZ cloud band
        const itcz = Math.exp(-lat * lat * 0.003) * 0.5;
        cloudFraction[idx] = (noise * 0.4 + itcz);
        humidity[idx] = 0.6 - Math.abs(lat) * 0.003 + noise * 0.1;

        // Trade winds
        u[idx] = -Math.cos(lat * Math.PI / 180 * 2) * 10;
        v[idx] = Math.sin(nx * 0.5) * 3;
      }
    }

    return {
      width,
      height,
      fields: { cloudFraction, humidity, u, v },
    };
  }
}
