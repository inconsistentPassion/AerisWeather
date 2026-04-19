/**
 * WeatherManager — Central weather data pipeline.
 * Fetches from backend proxy, caches, interpolates, distributes to consumers.
 * 
 * v3: Time interpolation, prefetching, loading states.
 */

import type { WeatherLevel, WeatherLayer, WeatherGrid, TimeRange } from './types';
import { fetchRealWeatherGrid } from './OpenMeteo';

const DEFAULT_LEVELS: WeatherLevel[] = ['surface', '850hPa', '500hPa', 'FL100', 'FL200', 'FL300'];
const DEFAULT_LAYERS: WeatherLayer[] = ['wind', 'temperature', 'pressure', 'humidity', 'radar'];
const API_BASE = 'http://localhost:3001';

// Interpolation cache: holds current + next time steps
interface TimeCacheEntry {
  time: number;
  grid: WeatherGrid;
}

export class WeatherManager {
  private grids: Map<string, WeatherGrid> = new Map();
  private timeCache: Map<string, TimeCacheEntry[]> = new Map(); // level -> sorted entries
  private currentTime: number = Date.now();
  private currentLevel: WeatherLevel = 'surface';
  private activeLayers: Set<WeatherLayer> = new Set(['wind', 'radar']);
  private isLoading: boolean = false;
  private fetchInterval: ReturnType<typeof setInterval> | null = null;

  // Event callbacks
  private listeners: Map<string, Set<Function>> = new Map();

  /**
   * Load initial weather data for the default view.
   */
  async loadInitial(): Promise<void> {
    this.setLoading(true);
    
    try {
      // Priority 1: Real data from Open-Meteo (free, no key, global)
      // Timeout after 10s to avoid blocking UI
      const realGrid = await Promise.race([
        fetchRealWeatherGrid(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 10000)),
      ]);
      if (realGrid) {
        this.grids.set('surface', realGrid);
        this.addTimeCache('surface', Date.now(), realGrid);
        console.log('[Weather] Using real Open-Meteo data');
      } else {
        // Priority 2: Backend server
        const serverGrid = await this.fetchGrid('surface', Date.now());
        if (serverGrid) {
          this.grids.set('surface', serverGrid);
          this.addTimeCache('surface', Date.now(), serverGrid);
          console.log('[Weather] Using server data');
        } else {
          // Priority 3: Procedural fallback
          this.grids.set('surface', this.generatePlaceholderGrid(360, 180));
          console.log('[Weather] Using procedural fallback');
        }
      }
      
      this.emit('dataLoaded', { level: 'surface' });
    } catch (e) {
      console.warn('[Weather] Load failed:', e);
      this.grids.set('surface', this.generatePlaceholderGrid(360, 180));
      this.emit('dataLoaded', { level: 'surface' });
    }
    
    this.setLoading(false);

    // Refresh from Open-Meteo every 15 minutes
    setInterval(async () => {
      const fresh = await fetchRealWeatherGrid();
      if (fresh) {
        this.grids.set('surface', fresh);
        this.emit('dataLoaded', { level: 'surface' });
      }
    }, 15 * 60 * 1000);
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
      
      // Parse the response — server returns fields directly
      return this.parseApiGrid(data);
    } catch {
      return null;
    }
  }

  /**
   * Parse API response into WeatherGrid format.
   */
  private parseApiGrid(data: any): WeatherGrid {
    // Server returns: { width, height, fields: { cloudFraction, humidity, u, v, w, temperature } }
    // Fields can be arrays (from JSON) or Float32Arrays
    const parseField = (field: any): Float32Array | undefined => {
      if (!field) return undefined;
      if (field instanceof Float32Array) return field;
      if (Array.isArray(field)) return new Float32Array(field);
      return undefined;
    };

    return {
      width: data.width || 360,
      height: data.height || 180,
      fields: {
        cloudFraction: parseField(data.fields?.cloudFraction),
        humidity: parseField(data.fields?.humidity),
        temperature: parseField(data.fields?.temperature),
        u: parseField(data.fields?.u),
        v: parseField(data.fields?.v),
        w: parseField(data.fields?.w),
      },
    };
  }

  /**
   * Add entry to time cache, keeping sorted by time.
   */
  private addTimeCache(level: string, time: number, grid: WeatherGrid): void {
    if (!this.timeCache.has(level)) {
      this.timeCache.set(level, []);
    }
    
    const entries = this.timeCache.get(level)!;
    
    // Remove existing entry for this time
    const existing = entries.findIndex(e => Math.abs(e.time - time) < 60000); // 1 min tolerance
    if (existing >= 0) {
      entries.splice(existing, 1);
    }
    
    entries.push({ time, grid });
    entries.sort((a, b) => a.time - b.time);
    
    // Keep max 10 entries per level
    while (entries.length > 10) {
      entries.shift();
    }
  }

  /**
   * Interpolate between two time steps.
   */
  private interpolateGrids(a: WeatherGrid, b: WeatherGrid, t: number): WeatherGrid {
    const lerp = (x: number, y: number, t: number) => x + (y - x) * t;
    
    const interpField = (fa: Float32Array | undefined, fb: Float32Array | undefined): Float32Array | undefined => {
      if (!fa || !fb) return fa || fb;
      const result = new Float32Array(fa.length);
      for (let i = 0; i < fa.length; i++) {
        result[i] = lerp(fa[i], fb[i], t);
      }
      return result;
    };

    return {
      width: a.width,
      height: a.height,
      fields: {
        cloudFraction: interpField(a.fields.cloudFraction, b.fields.cloudFraction),
        humidity: interpField(a.fields.humidity, b.fields.humidity),
        temperature: interpField(a.fields.temperature, b.fields.temperature),
        u: interpField(a.fields.u, b.fields.u),
        v: interpField(a.fields.v, b.fields.v),
        w: interpField(a.fields.w, b.fields.w),
      },
    };
  }

  /**
   * Get interpolated grid for a specific time.
   */
  private getInterpolatedGrid(level: string, time: number): WeatherGrid | null {
    const entries = this.timeCache.get(level);
    if (!entries || entries.length === 0) return null;
    
    // Find surrounding entries
    let before: TimeCacheEntry | null = null;
    let after: TimeCacheEntry | null = null;
    
    for (const entry of entries) {
      if (entry.time <= time) {
        before = entry;
      } else {
        after = entry;
        break;
      }
    }
    
    if (!before && !after) return null;
    if (!before) return after!.grid;
    if (!after) return before.grid;
    if (before.time === after.time) return before.grid;
    
    // Interpolate
    const t = (time - before.time) / (after.time - before.time);
    return this.interpolateGrids(before.grid, after.grid, t);
  }

  /**
   * Update per frame — handles interpolation, pre-fetching, etc.
   */
  update(dt: number): void {
    // Interpolate current grid if we have time cache
    const interpolated = this.getInterpolatedGrid(this.currentLevel, this.currentTime);
    if (interpolated) {
      this.grids.set(this.currentLevel, interpolated);
    }
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
   * Get temperature field for overlay.
   */
  getTemperatureField(): Float32Array | null {
    const grid = this.grids.get(this.currentLevel);
    if (!grid) return null;
    return grid.fields.temperature ?? null;
  }

  /**
   * Get humidity field for overlay.
   */
  getHumidityField(): Float32Array | null {
    const grid = this.grids.get(this.currentLevel);
    if (!grid) return null;
    return grid.fields.humidity ?? null;
  }

  /**
   * Set the current forecast time. Prefetches adjacent steps.
   */
  async setTime(timestamp: number): Promise<void> {
    this.currentTime = timestamp;
    this.emit('timeChange', { time: timestamp });

    // Check if we need to fetch new data
    const entries = this.timeCache.get(this.currentLevel) || [];
    const hasNearby = entries.some(e => Math.abs(e.time - timestamp) < 3600000); // 1h tolerance
    
    if (!hasNearby) {
      this.setLoading(true);
      
      // Fetch current + adjacent time steps
      const steps = [
        timestamp - 3 * 3600000,
        timestamp,
        timestamp + 3 * 3600000,
      ];
      
      for (const time of steps) {
        if (time < Date.now() - 86400000) continue; // don't fetch too far in past
        const grid = await this.fetchGrid(this.currentLevel, time);
        if (grid) {
          this.addTimeCache(this.currentLevel, time, grid);
        }
      }
      
      this.setLoading(false);
      this.emit('dataLoaded', { level: this.currentLevel });
    }
  }

  /**
   * Set the active vertical level. Fetches if not cached.
   */
  async setLevel(level: WeatherLevel): Promise<void> {
    this.currentLevel = level;
    this.emit('levelChange', { level });

    // Fetch if we don't have this level
    if (!this.timeCache.has(level) || this.timeCache.get(level)!.length === 0) {
      this.setLoading(true);
      
      try {
        const grid = await this.fetchGrid(level, this.currentTime);
        if (grid) {
          this.addTimeCache(level, this.currentTime, grid);
          this.grids.set(level, grid);
          this.emit('dataLoaded', { level });
        } else {
          this.grids.set(level, this.generatePlaceholderGrid(360, 180));
          this.emit('dataLoaded', { level });
        }
      } catch {
        this.grids.set(level, this.generatePlaceholderGrid(360, 180));
        this.emit('dataLoaded', { level });
      }
      
      this.setLoading(false);
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

  /**
   * Check if data is currently loading.
   */
  getLoading(): boolean {
    return this.isLoading;
  }

  private setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.emit('loadingChange', { loading });
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
    const temperature = new Float32Array(size);
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
        temperature[idx] = 20 - Math.abs(lat) * 0.5 + noise * 5;

        // Trade winds
        u[idx] = -Math.cos(lat * Math.PI / 180 * 2) * 10;
        v[idx] = Math.sin(nx * 0.5) * 3;
      }
    }

    return {
      width,
      height,
      fields: { cloudFraction, humidity, temperature, u, v },
    };
  }
}
