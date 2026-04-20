/**
 * DeckLayers — Weather visualization using deck.gl ScatterplotLayers.
 *
 * Uses MapboxOverlay (deck.gl) + MapLibre for automatic coordinate projection.
 * Positions are [longitude, latitude, altitudeMeters] — deck.gl handles everything.
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { WeatherManager } from './WeatherManager';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface CloudPoint { position: [number, number, number]; color: [number, number, number]; radius: number; opacity: number; }
interface WindPoint { path: [number, number, number][]; color: [number, number, number, number]; }
interface RainDrop { position: [number, number, number]; color: [number, number, number]; radius: number; opacity: number; }

// ── Constants ─────────────────────────────────────────────────────────

const CLOUD_ALTITUDES = [
  { name: 'low', alt: 1200, spread: 1800, color: [245, 245, 250] as [number, number, number] },
  { name: 'medium', alt: 5000, spread: 3000, color: [225, 230, 240] as [number, number, number] },
  { name: 'high', alt: 9500, spread: 4000, color: [210, 222, 248] as [number, number, number] },
];

const WIND_COLORS: [number, number, number, number][] = [
  [30, 100, 220, 160],
  [55, 180, 210, 170],
  [80, 240, 195, 170],
  [140, 255, 120, 170],
  [210, 230, 55, 170],
  [255, 180, 30, 185],
  [255, 100, 15, 195],
  [255, 30, 10, 210],
];

const RAIN_COLORS: [number, number, number][] = [
  [90, 140, 210],
  [130, 180, 235],
  [170, 215, 255],
  [210, 235, 255],
  [245, 250, 255],
];

// ── Main class ────────────────────────────────────────────────────────

export class DeckLayers {
  private overlay: MapboxOverlay;
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;

  private cloudVisible = true;
  private windVisible = true;
  private radarVisible = true;

  // Cached data
  private cloudData: CloudPoint[] = [];
  private windData: WindPoint[] = [];
  private rainData: RainDrop[] = [];

  // Particles for wind animation
  private particles: Array<{ lon: number; lat: number; age: number; speed: number }> = [];

  private dirty = true;
  private animId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(weather: WeatherManager) {
    this.weather = weather;
    this.overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
    });

    // Listen for data changes
    weather.on('dataLoaded', () => { this.dirty = true; });
    weather.on('cloudLayersLoaded', () => { this.dirty = true; });
    weather.on('timeChange', () => { this.dirty = true; });

    // Init wind particles
    for (let i = 0; i < 8000; i++) {
      this.particles.push({
        lon: (Math.random() - 0.5) * 360,
        lat: (Math.random() - 0.5) * 180,
        age: Math.floor(Math.random() * 80),
        speed: 0.3 + Math.random() * 0.7,
      });
    }
  }

  /** Get the MapboxOverlay control to add to MapLibre */
  getControl(): MapboxOverlay {
    return this.overlay;
  }

  /** Call after map.load() */
  onMapReady(map: maplibregl.Map): void {
    this.map = map;
    this.buildCloudData();
    this.startAnimation();

    this.timer = setInterval(() => {
      this.buildCloudData();
      this.updateLayers();
    }, 10000);
  }

  setVisible(layer: 'clouds' | 'wind' | 'radar', visible: boolean): void {
    switch (layer) {
      case 'clouds': this.cloudVisible = visible; break;
      case 'wind': this.windVisible = visible; break;
      case 'radar': this.radarVisible = visible; break;
    }
    this.updateLayers();
  }

  destroy(): void {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.timer) clearInterval(this.timer);
  }

  // ── Cloud data ──────────────────────────────────────────────────────

  private buildCloudData(): void {
    const cloudLayers = this.weather.getCloudLayers();
    const grid = this.weather.getGrid('surface');
    const cloudFraction = grid?.fields?.cloudFraction;
    if (!cloudFraction && !cloudLayers) return;

    const data: CloudPoint[] = [];
    const w = 360, h = 180;

    for (let band = 0; band < 3; band++) {
      const cfg = CLOUD_ALTITUDES[band];
      const coverage = cloudLayers
        ? [cloudLayers.low, cloudLayers.medium, cloudLayers.high][band]
        : cloudFraction;
      if (!coverage) continue;

      // Sample every N cells for performance
      const step = 4;
      for (let j = 0; j < h; j += step) {
        for (let i = 0; i < w; i += step) {
          let c = coverage[j * w + i];
          if (c > 1) c /= 100;
          if (!cloudLayers && cloudFraction) c *= [0.5, 0.3, 0.2][band];
          if (c < 0.15) continue;

          const lon = (i / w) * 360 - 180 + (Math.random() - 0.5) * 2;
          const lat = 90 - (j / h) * 180 + (Math.random() - 0.5) * 1;
          const alt = cfg.alt + (Math.random() - 0.5) * cfg.spread;

          data.push({
            position: [lon, lat, Math.max(100, alt)],
            color: cfg.color,
            radius: 5000 + c * 15000,
            opacity: 0.15 + c * 0.45,
          });
        }
      }
    }

    this.cloudData = data;
    console.log(`[DeckClouds] ${data.length} cloud points`);
  }

  // ── Wind animation ──────────────────────────────────────────────────

  private advectParticles(): void {
    const wf = this.weather.getWindField('surface');
    if (!wf) return;

    const { u, v } = wf;
    const gw = 360, gh = 180;

    for (const p of this.particles) {
      p.age++;
      if (p.age > 80 + Math.random() * 40) {
        p.lon = (Math.random() - 0.5) * 360;
        p.lat = (Math.random() - 0.5) * 180;
        p.age = 0;
        continue;
      }

      // Sample wind
      const nLon = ((p.lon + 180) % 360 + 360) % 360;
      const x = (nLon / 360) * gw;
      const y = ((90 - p.lat) / 180) * gh;
      const x0 = Math.floor(x) % gw, y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
      const x1 = (x0 + 1) % gw, y1 = Math.min(gh - 1, y0 + 1);
      const fx = x - Math.floor(x), fy = y - Math.floor(y);

      const bl = (a: number, b: number, c: number, d: number) =>
        a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;

      const uVal = bl(u[y0 * gw + x0], u[y0 * gw + x1], u[y1 * gw + x0], u[y1 * gw + x1]);
      const vVal = bl(v[y0 * gw + x0], v[y0 * gw + x1], v[y1 * gw + x0], v[y1 * gw + x1]);
      const speed = Math.sqrt(uVal * uVal + vVal * vVal);

      if (speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(p.lat * Math.PI / 180));
        const sf = Math.sqrt(speed);
        p.lon += (uVal / speed) * sf * 0.004 / cosLat;
        p.lat += (vVal / speed) * sf * 0.004;
        if (p.lon > 180) p.lon -= 360;
        if (p.lon < -180) p.lon += 360;
        p.lat = Math.max(-85, Math.min(85, p.lat));
      }
    }
  }

  private buildWindData(): void {
    const wf = this.weather.getWindField('surface');
    if (!wf) { this.windData = []; return; }

    const data: WindPoint[] = [];

    for (const p of this.particles) {
      if (p.age < 5) continue;

      const wf2 = this.weather.getWindField('surface');
      if (!wf2) break;
      const { u, v } = wf2;
      const gw = 360, gh = 180;
      const nLon = ((p.lon + 180) % 360 + 360) % 360;
      const x = (nLon / 360) * gw, y = ((90 - p.lat) / 180) * gh;
      const x0 = Math.floor(x) % gw, y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
      const idx = y0 * gw + x0;
      const speed = Math.sqrt((u[idx] || 0) ** 2 + (v[idx] || 0) ** 2);

      if (speed < 0.5) continue;

      const bin = Math.min(7, Math.floor((speed / 25) * 8));
      const [r, g, b, a] = WIND_COLORS[bin];

      // Short trail: current → slightly behind
      const trailLen = 2;
      const cosLat = Math.max(0.3, Math.cos(p.lat * Math.PI / 180));
      const sf = Math.sqrt(speed);
      const dLon = -(u[idx] / speed) * sf * 0.004 * trailLen / cosLat;
      const dLat = -(v[idx] / speed) * sf * 0.004 * trailLen;

      const path: [number, number, number][] = [
        [p.lon, p.lat, 500],
        [p.lon + dLon, p.lat + dLat, 500],
      ];

      data.push({
        path,
        color: [r, g, b, Math.round(a * Math.min(1, p.age / 10))],
      });
    }

    this.windData = data;
  }

  // ── Rain drops ──────────────────────────────────────────────────────

  private buildRainData(): void {
    // Simple rain visualization — scatter drops where cloud coverage is high
    const grid = this.weather.getGrid('surface');
    if (!grid) { this.rainData = []; return; }
    const { fields } = grid;
    if (!fields?.cloudFraction || !fields?.humidity) {
      this.rainData = [];
      return;
    }

    const cloudFraction = fields.cloudFraction;
    const humidity = fields.humidity;
    const w = 360, h = 180;
    const drops: RainDrop[] = [];
    const step = 8;

    for (let j = 0; j < h; j += step) {
      for (let i = 0; i < w; i += step) {
        let cf = cloudFraction[j * w + i];
        const hum = humidity[j * w + i];
        if (cf > 1) cf /= 100;
        // Rain where clouds + humidity are high
        if (cf < 0.5 || hum < 70) continue;

        const intensity = (cf - 0.5) * 2 * ((hum - 70) / 30);
        if (intensity < 0.1) continue;

        const lon = (i / w) * 360 - 180 + (Math.random() - 0.5) * 3;
        const lat = 90 - (j / h) * 180 + (Math.random() - 0.5) * 2;
        const bin = Math.min(4, Math.floor(intensity * 5));
        const [r, g, b] = RAIN_COLORS[bin];

        drops.push({
          position: [lon, lat, 200],
          color: [r, g, b],
          radius: 1000 + intensity * 3000,
          opacity: 0.2 + intensity * 0.5,
        });
      }
    }

    this.rainData = drops;
  }

  // ── Animation loop ──────────────────────────────────────────────────

  private startAnimation(): void {
    const tick = () => {
      this.advectParticles();
      this.buildWindData();
      this.buildRainData();
      this.updateLayers();
      this.animId = requestAnimationFrame(tick);
    };
    // Throttle to ~20fps for wind
    let lastFrame = 0;
    const throttledTick = (now: number) => {
      if (now - lastFrame > 50) {
        lastFrame = now;
        this.advectParticles();
        this.buildWindData();
        this.updateLayers();
      }
      this.animId = requestAnimationFrame(throttledTick);
    };
    this.animId = requestAnimationFrame(throttledTick);
  }

  // ── Layer updates ───────────────────────────────────────────────────

  private updateLayers(): void {
    const layers: any[] = [];

    // Clouds
    if (this.cloudVisible && this.cloudData.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'deck-clouds',
        data: this.cloudData,
        getPosition: (d: CloudPoint) => d.position,
        getRadius: (d: CloudPoint) => d.radius,
        getFillColor: (d: CloudPoint) => d.color,
        opacity: 0.35,
        radiusUnits: 'meters',
        radiusMinPixels: 2,
        radiusMaxPixels: 50,
        pickable: false,
        updateTriggers: {
          data: this.cloudData.length,
        },
      }));
    }

    // Wind particles
    if (this.windVisible && this.windData.length > 0) {
      layers.push(new PathLayer({
        id: 'deck-wind',
        data: this.windData,
        getPath: (d: WindPoint) => d.path,
        getColor: (d: WindPoint) => d.color,
        getWidth: 1.5,
        widthUnits: 'pixels',
        opacity: 0.8,
        pickable: false,
        rounded: true,
      }));
    }

    // Rain
    if (this.radarVisible && this.rainData.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'deck-rain',
        data: this.rainData,
        getPosition: (d: RainDrop) => d.position,
        getRadius: (d: RainDrop) => d.radius,
        getFillColor: (d: RainDrop) => d.color,
        opacity: 0.4,
        radiusUnits: 'meters',
        radiusMinPixels: 1,
        radiusMaxPixels: 8,
        pickable: false,
      }));
    }

    this.overlay.setProps({ layers });
  }
}
