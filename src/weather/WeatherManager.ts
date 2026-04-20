/**
 * WeatherManager — Central weather data pipeline.
 *
 * Fetches from backend proxy, caches, distributes to consumers.
 * Supports both single-level grids and 3-layer cloud data.
 */

import type { WeatherLevel, WeatherLayer, WeatherGrid, CloudLayers } from './types';
import { fetchRealWeatherGrid } from './OpenMeteo';

const API_BASE = 'http://localhost:3001';

export class WeatherManager {
  private grids: Map<string, WeatherGrid> = new Map();
  private cloudLayers: CloudLayers | null = null;
  private currentTime: number = Date.now();
  private currentLevel: WeatherLevel = 'surface';
  private activeLayers: Set<WeatherLayer> = new Set(['wind', 'radar', 'clouds']);
  private isLoading: boolean = false;

  private listeners: Map<string, Set<Function>> = new Map();

  async loadInitial(): Promise<void> {
    this.setLoading(true);

    try {
      // Priority 1: Real data from Open-Meteo
      const realGrid = await Promise.race([
        fetchRealWeatherGrid(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 60000)),
      ]);
      if (realGrid) {
        this.grids.set('surface', realGrid);
        console.log('[Weather] Using real Open-Meteo data');
      } else {
        this.grids.set('surface', await this.fetchGrid('surface', this.currentTime));
        console.log('[Weather] Using backend data');
      }

      this.emit('dataLoaded', { level: 'surface' });

      // Fetch cloud layers (async, non-blocking)
      this.fetchCloudLayers().catch(e =>
        console.warn('[Weather] Cloud layers fetch failed:', e)
      );
    } catch (e) {
      console.warn('[Weather] Load failed:', e);
      this.grids.set('surface', this.generatePlaceholderGrid(360, 180));
      this.emit('dataLoaded', { level: 'surface' });
    }

    this.setLoading(false);

    // Refresh cloud layers every 30 minutes
    setInterval(() => {
      this.fetchCloudLayers().catch(e =>
        console.warn('[Weather] Cloud layers refresh failed:', e)
      );
    }, 30 * 60 * 1000);
  }

  /**
   * Fetch 3-layer cloud data from the backend.
   */
  async fetchCloudLayers(): Promise<CloudLayers | null> {
    try {
      const timeStr = new Date(this.currentTime).toISOString();
      const res = await fetch(`${API_BASE}/api/weather/cloud-layers?time=${timeStr}&width=360&height=180`);
      if (!res.ok) return null;

      const data = await res.json();

      this.cloudLayers = {
        width: data.width || 360,
        height: data.height || 180,
        low: new Float32Array(data.low),
        medium: new Float32Array(data.medium),
        high: new Float32Array(data.high),
        windU: new Float32Array(data.windU),
        windV: new Float32Array(data.windV),
        source: data.source,
      };

      console.log(`[Weather] Cloud layers loaded (${this.cloudLayers.source})`);
      this.emit('cloudLayersLoaded', this.cloudLayers);
      return this.cloudLayers;
    } catch (e) {
      console.warn('[Weather] Cloud layers fetch error:', e);
      return null;
    }
  }

  /**
   * Fetch a single-level weather grid from the backend.
   */
  private async fetchGrid(level: string, time: number): Promise<WeatherGrid> {
    try {
      const timeStr = new Date(time).toISOString();
      const res = await fetch(`${API_BASE}/api/weather/grid?level=${level}&time=${timeStr}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return this.parseGridResponse(data);
    } catch {
      return this.generatePlaceholderGrid(360, 180);
    }
  }

  private parseGridResponse(data: any): WeatherGrid {
    const pf = (f: any): Float32Array | undefined => {
      if (!f) return undefined;
      if (f instanceof Float32Array) return f;
      if (Array.isArray(f)) return new Float32Array(f);
      return undefined;
    };
    return {
      width: data.width || 360,
      height: data.height || 180,
      fields: {
        cloudFraction: pf(data.fields?.cloudFraction),
        humidity: pf(data.fields?.humidity),
        temperature: pf(data.fields?.temperature),
        u: pf(data.fields?.u),
        v: pf(data.fields?.v),
        w: pf(data.fields?.w),
      },
    };
  }

  // ── Public API ─────────────────────────────────────────────────────

  getGrid(level: WeatherLevel): WeatherGrid | undefined {
    return this.grids.get(level);
  }

  getCloudLayers(): CloudLayers | null {
    return this.cloudLayers;
  }

  getWindField(level: WeatherLevel): { u: Float32Array; v: Float32Array } | null {
    const grid = this.grids.get(level);
    if (!grid || !grid.fields.u || !grid.fields.v) return null;
    return { u: grid.fields.u, v: grid.fields.v };
  }

  async setTime(timestamp: number): Promise<void> {
    this.currentTime = timestamp;
    this.emit('timeChange', { time: timestamp });

    // Re-fetch cloud layers for new time
    this.fetchCloudLayers().catch(() => {});
  }

  async setLevel(level: WeatherLevel): Promise<void> {
    this.currentLevel = level;
    this.emit('levelChange', { level });

    if (!this.grids.has(level)) {
      this.setLoading(true);
      const grid = await this.fetchGrid(level, this.currentTime);
      this.grids.set(level, grid);
      this.setLoading(false);
      this.emit('dataLoaded', { level });
    }
  }

  toggleLayer(layer: WeatherLayer, active: boolean): void {
    if (active) this.activeLayers.add(layer);
    else this.activeLayers.delete(layer);
    this.emit('layerToggle', { layer, active });
  }

  isLayerActive(layer: WeatherLayer): boolean {
    return this.activeLayers.has(layer);
  }

  getLoading(): boolean { return this.isLoading; }

  private setLoading(loading: boolean): void {
    this.isLoading = loading;
    this.emit('loadingChange', { loading });
  }

  // ── Events ─────────────────────────────────────────────────────────

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

  // ── Placeholder ────────────────────────────────────────────────────

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
        const noise = (Math.sin(i * 0.03 + j * 0.02) * 0.5 + 0.5) *
                      (Math.cos(i * 0.01 - j * 0.04) * 0.5 + 0.5);
        cloudFraction[idx] = Math.exp(-lat * lat * 0.003) * 0.5 + noise * 0.3;
        humidity[idx] = 0.6 - Math.abs(lat) * 0.003 + noise * 0.1;
        temperature[idx] = 20 - Math.abs(lat) * 0.5 + noise * 5;
        u[idx] = -Math.cos(lat * Math.PI / 180 * 2) * 10;
        v[idx] = Math.sin(i * 0.02) * 3;
      }
    }

    return { width, height, fields: { cloudFraction, humidity, temperature, u, v } };
  }
}
