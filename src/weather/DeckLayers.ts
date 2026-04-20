/**
 * DeckLayers — Weather visualization using deck.gl ScatterplotLayers.
 *
 * Uses MapboxOverlay (deck.gl) + MapLibre for automatic coordinate projection.
 * Positions are [longitude, latitude, altitudeMeters] — deck.gl handles everything.
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { MapboxOverlayProps } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { WeatherManager } from './WeatherManager';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface CloudPoint { position: [number, number, number]; color: [number, number, number]; radius: number; }
interface WindTrail { path: [number, number, number][]; color: [number, number, number, number]; }
interface RainDrop { position: [number, number, number]; color: [number, number, number]; radius: number; }

// ── Constants ─────────────────────────────────────────────────────────

const CLOUD_ALTITUDES = [
  { name: 'low', alt: 1200, spread: 1800, color: [245, 245, 250] as [number, number, number] },
  { name: 'medium', alt: 5000, spread: 3000, color: [225, 230, 240] as [number, number, number] },
  { name: 'high', alt: 9500, spread: 4000, color: [210, 222, 248] as [number, number, number] },
];

const WIND_COLORS: [number, number, number, number][] = [
  [30, 100, 220, 180],
  [55, 180, 210, 190],
  [80, 240, 195, 190],
  [140, 255, 120, 190],
  [210, 230, 55, 190],
  [255, 180, 30, 200],
  [255, 100, 15, 210],
  [255, 30, 10, 220],
];

const RAIN_COLORS: [number, number, number][] = [
  [90, 140, 210],
  [130, 180, 235],
  [170, 215, 255],
  [210, 235, 255],
  [245, 250, 255],
];

// Trail length in simulation ticks per particle
const TRAIL_LENGTH = 6;
// Total wind particles
const NUM_PARTICLES = 6000;
// Advection speed
const BASE_SPEED = 0.005;

// ── Main class ────────────────────────────────────────────────────────

export class DeckLayers {
  private overlay: MapboxOverlay;
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;

  private cloudVisible = true;
  private windVisible = true;
  private radarVisible = true;

  // Cached layer data
  private cloudData: CloudPoint[] = [];
  private windData: WindTrail[] = [];
  private rainData: RainDrop[] = [];

  // Wind particle state: each particle has a trail of positions
  private particleLon = new Float64Array(NUM_PARTICLES);
  private particleLat = new Float64Array(NUM_PARTICLES);
  private particleAge = new Float32Array(NUM_PARTICLES);
  private particleTrailLon: Float64Array[] = [];
  private particleTrailLat: Float64Array[] = [];
  private particleTrailHead = new Uint16Array(NUM_PARTICLES);

  private animId: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameCount = 0;

  constructor(weather: WeatherManager) {
    this.weather = weather;

    // Init particle trails
    for (let i = 0; i < NUM_PARTICLES; i++) {
      this.particleTrailLon.push(new Float64Array(TRAIL_LENGTH));
      this.particleTrailLat.push(new Float64Array(TRAIL_LENGTH));
      this.spawnParticle(i);
    }

    this.overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
    });

    weather.on('dataLoaded', () => { this.buildCloudData(); this.updateLayers(); });
    weather.on('cloudLayersLoaded', () => { this.buildCloudData(); this.updateLayers(); });
    weather.on('timeChange', () => { this.buildCloudData(); this.updateLayers(); });
  }

  getControl(): MapboxOverlay {
    return this.overlay;
  }

  onMapReady(map: maplibregl.Map): void {
    this.map = map;
    this.buildCloudData();
    this.startAnimation();

    // Also update on map move so deck.gl re-renders
    map.on('move', () => this.updateLayers());
    map.on('zoom', () => this.updateLayers());
    map.on('rotate', () => this.updateLayers());
    map.on('pitch', () => this.updateLayers());
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

  // ── Particle management ─────────────────────────────────────────────

  private spawnParticle(i: number): void {
    this.particleLon[i] = (Math.random() - 0.5) * 360;
    this.particleLat[i] = (Math.random() - 0.5) * 170;
    this.particleAge[i] = Math.random() * 40;
    this.particleTrailHead[i] = 0;
    for (let t = 0; t < TRAIL_LENGTH; t++) {
      this.particleTrailLon[i][t] = this.particleLon[i];
      this.particleTrailLat[i][t] = this.particleLat[i];
    }
  }

  private sampleWind(u: Float32Array, v: Float32Array, lon: number, lat: number) {
    const gw = 360, gh = 180;
    const nLon = ((lon + 180) % 360 + 360) % 360;
    const x = (nLon / 360) * gw;
    const y = ((90 - lat) / 180) * gh;
    const x0 = Math.floor(x) % gw;
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
    const x1 = (x0 + 1) % gw;
    const y1 = Math.min(gh - 1, y0 + 1);
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const bl = (a: number, b: number, c: number, d: number) =>
      a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    const uVal = bl(u[y0 * gw + x0], u[y0 * gw + x1], u[y1 * gw + x0], u[y1 * gw + x1]);
    const vVal = bl(v[y0 * gw + x0], v[y0 * gw + x1], v[y1 * gw + x0], v[y1 * gw + x1]);
    return { u: uVal, v: vVal, speed: Math.sqrt(uVal * uVal + vVal * vVal) };
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

      const step = 4; // sample every 4° for perf
      for (let j = 0; j < h; j += step) {
        for (let i = 0; i < w; i += step) {
          let c = coverage[j * w + i];
          if (c > 1) c /= 100;
          if (!cloudLayers && cloudFraction) c *= [0.5, 0.3, 0.2][band];
          if (c < 0.12) continue;

          const lon = (i / w) * 360 - 180 + (Math.random() - 0.5) * 2;
          const lat = 90 - (j / h) * 180 + (Math.random() - 0.5) * 1;
          const alt = cfg.alt + (Math.random() - 0.5) * cfg.spread;

          data.push({
            position: [lon, lat, Math.max(100, alt)],
            color: cfg.color,
            radius: 8000 + c * 20000,
          });
        }
      }
    }

    this.cloudData = data;
    console.log(`[DeckClouds] ${data.length} cloud points`);
  }

  // ── Wind advection ──────────────────────────────────────────────────

  private advectAndBuildWind(): void {
    const wf = this.weather.getWindField('surface');
    if (!wf) { this.windData = []; return; }

    const { u, v } = wf;
    const data: WindTrail[] = [];

    for (let i = 0; i < NUM_PARTICLES; i++) {
      this.particleAge[i]++;

      // Respawn old particles
      if (this.particleAge[i] > 80 + Math.random() * 60) {
        this.spawnParticle(i);
        continue;
      }

      const wind = this.sampleWind(u, v, this.particleLon[i], this.particleLat[i]);

      if (wind.speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.particleLat[i] * Math.PI / 180));
        const sf = Math.sqrt(wind.speed);
        this.particleLon[i] += (wind.u / wind.speed) * sf * BASE_SPEED / cosLat;
        this.particleLat[i] += (wind.v / wind.speed) * sf * BASE_SPEED;
        if (this.particleLon[i] > 180) this.particleLon[i] -= 360;
        if (this.particleLon[i] < -180) this.particleLon[i] += 360;
        this.particleLat[i] = Math.max(-85, Math.min(85, this.particleLat[i]));
      }

      // Record trail
      const head = this.particleTrailHead[i];
      this.particleTrailLon[i][head] = this.particleLon[i];
      this.particleTrailLat[i][head] = this.particleLat[i];
      this.particleTrailHead[i] = (head + 1) % TRAIL_LENGTH;

      // Skip particles still building up trail
      if (this.particleAge[i] < TRAIL_LENGTH || wind.speed < 0.5) continue;

      // Skip if trail wraps across dateline
      let datelineBreak = false;
      for (let t = 0; t < TRAIL_LENGTH - 1; t++) {
        const s0 = (head + t) % TRAIL_LENGTH;
        const s1 = (head + t + 1) % TRAIL_LENGTH;
        if (Math.abs(this.particleTrailLon[i][s1] - this.particleTrailLon[i][s0]) > 15) {
          datelineBreak = true;
          break;
        }
      }
      if (datelineBreak) continue;

      // Build path from trail
      const path: [number, number, number][] = [];
      for (let t = 0; t < TRAIL_LENGTH; t++) {
        const idx = (head + t) % TRAIL_LENGTH;
        path.push([
          this.particleTrailLon[i][idx],
          this.particleTrailLat[i][idx],
          800, // elevation above surface (meters)
        ]);
      }

      const bin = Math.min(7, Math.floor((wind.speed / 25) * 8));
      const [r, g, b, a] = WIND_COLORS[bin];
      const ageFade = Math.min(1, this.particleAge[i] / 10);

      data.push({
        path,
        color: [r, g, b, Math.round(a * ageFade)],
      });
    }

    this.windData = data;
  }

  // ── Rain drops ──────────────────────────────────────────────────────

  private buildRainData(): void {
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
    const step = 6;

    for (let j = 0; j < h; j += step) {
      for (let i = 0; i < w; i += step) {
        let cf = cloudFraction[j * w + i];
        const hum = humidity[j * w + i];
        if (cf > 1) cf /= 100;
        // Rain where both clouds + humidity are high
        if (cf < 0.5 || hum < 65) continue;

        const intensity = (cf - 0.5) * 2 * Math.max(0, (hum - 65) / 35);
        if (intensity < 0.1) continue;

        const lon = (i / w) * 360 - 180 + (Math.random() - 0.5) * 3;
        const lat = 90 - (j / h) * 180 + (Math.random() - 0.5) * 2;
        const bin = Math.min(4, Math.floor(intensity * 5));
        const [r, g, b] = RAIN_COLORS[bin];

        drops.push({
          position: [lon, lat, 300],
          color: [r, g, b],
          radius: 2000 + intensity * 5000,
        });
      }
    }

    this.rainData = drops;
  }

  // ── Animation loop ──────────────────────────────────────────────────

  private startAnimation(): void {
    // ~15fps for wind advection (throttled for perf)
    let lastFrame = 0;
    const tick = (now: number) => {
      if (now - lastFrame > 66) { // ~15fps
        lastFrame = now;
        this.frameCount++;
        this.advectAndBuildWind();
        if (this.frameCount % 3 === 0) {
          this.buildRainData();
        }
        this.updateLayers();
      }
      this.animId = requestAnimationFrame(tick);
    };
    this.animId = requestAnimationFrame(tick);
  }

  // ── Layer updates ───────────────────────────────────────────────────

  private updateLayers(): void {
    const layers: any[] = [];

    // Clouds — ScatterplotLayer in LNGLAT with meter radii
    if (this.cloudVisible && this.cloudData.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'deck-clouds',
        data: this.cloudData,
        getPosition: (d: CloudPoint) => d.position,
        getRadius: (d: CloudPoint) => d.radius,
        getFillColor: (d: CloudPoint) => d.color,
        opacity: 0.3,
        radiusUnits: 'meters',
        radiusMinPixels: 2,
        radiusMaxPixels: 60,
        pickable: false,
        parameters: { depthTest: false },
      }));
    }

    // Wind — PathLayer with multi-segment trails
    if (this.windVisible && this.windData.length > 0) {
      layers.push(new PathLayer({
        id: 'deck-wind',
        data: this.windData,
        getPath: (d: WindTrail) => d.path,
        getColor: (d: WindTrail) => d.color,
        getWidth: 2,
        widthUnits: 'pixels',
        opacity: 0.9,
        pickable: false,
        capRounded: true,
        jointRounded: true,
        parameters: { depthTest: false },
      }));
    }

    // Rain — ScatterplotLayer
    if (this.radarVisible && this.rainData.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'deck-rain',
        data: this.rainData,
        getPosition: (d: RainDrop) => d.position,
        getRadius: (d: RainDrop) => d.radius,
        getFillColor: (d: RainDrop) => d.color,
        opacity: 0.45,
        radiusUnits: 'meters',
        radiusMinPixels: 1,
        radiusMaxPixels: 10,
        pickable: false,
        parameters: { depthTest: false },
      }));
    }

    this.overlay.setProps({ layers });
  }
}
