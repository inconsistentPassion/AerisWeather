/**
 * DeckLayers — Weather visualization using deck.gl layers.
 *
 * Clouds: Global ScatterplotLayer (2D cloud coverage from weather data)
 *         + PointCloudLayer (3D volumetric when focused on city)
 * Wind:   PathLayer (dense particle trails)
 * Rain:   ScatterplotLayer (generated from cloud/humidity data globally)
 *
 * The GLOBAL 2D cloud layer confirms data is flowing — like Windy's cloud overlay.
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer, ColumnLayer } from '@deck.gl/layers';
import type { WeatherManager } from './WeatherManager';
import { loadRadarCells, getCachedRadarCells } from './RadarData';
import { generateCloudNoise, generateHeightNoise, generateStormNoise } from './CloudNoise';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface WindTrail {
  path: [number, number, number][];
  color: [number, number, number, number];
}

interface RainDrop {
  position: [number, number, number];
  color: [number, number, number, number];
  radius: number;
}

interface CloudDot {
  position: [number, number];
  color: [number, number, number, number];
  radius: number;
}

interface City {
  name: string;
  lon: number;
  lat: number;
}

// ── Constants ─────────────────────────────────────────────────────────

const NUM_WIND_PARTICLES = 8000;
const WIND_TRAIL_LENGTH = 12;
const BASE_WIND_SPEED = 0.008;

const WIND_COLORS: [number, number, number, number][] = [
  [30, 100, 220, 200],
  [55, 180, 210, 210],
  [80, 240, 195, 210],
  [140, 255, 120, 210],
  [210, 230, 55, 210],
  [255, 180, 30, 220],
  [255, 100, 15, 230],
  [255, 30, 10, 240],
];

// ── Global 2D cloud visualization (Windy-style heatmap dots) ──────────

const CLOUD_COLORS: [number, number, number, number][] = [
  [200, 210, 230, 20],   // < 0.1 — barely visible
  [180, 195, 225, 50],   // 0.1-0.25
  [160, 180, 220, 90],   // 0.25-0.4
  [140, 165, 215, 130],  // 0.4-0.55
  [120, 150, 210, 170],  // 0.55-0.7
  [100, 135, 205, 200],  // 0.7-0.85
  [80, 120, 200, 230],   // 0.85-0.95
  [60, 105, 195, 255],   // > 0.95 — fully opaque
];

const RAIN_COLORS: [number, number, number, number][] = [
  [90, 140, 210, 140],
  [130, 180, 235, 170],
  [170, 215, 255, 200],
  [210, 235, 255, 230],
  [245, 250, 255, 255],
];

// ── Main class ────────────────────────────────────────────────────────

export class DeckLayers {
  private overlay: MapboxOverlay;
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;

  private cloudVisible = true;
  private windVisible = true;
  private radarVisible = true;

  private focusedCity: City | null = null;

  // Wind state
  private windLon = new Float64Array(NUM_WIND_PARTICLES);
  private windLat = new Float64Array(NUM_WIND_PARTICLES);
  private windAge = new Float32Array(NUM_WIND_PARTICLES);
  private windTrailLon: Float64Array[] = [];
  private windTrailLat: Float64Array[] = [];
  private windTrailHead = new Uint16Array(NUM_WIND_PARTICLES);

  private windData: WindTrail[] = [];

  // Rain — generated from weather data
  private rainDrops: Array<{
    lon: number; lat: number;
    elev: number; fallSpeed: number;
    intensity: number; age: number; maxAge: number;
  }> = [];
  private rainData: RainDrop[] = [];

  // Cloud dots — global 2D visualization
  private cloudDots: CloudDot[] = [];

  private animId: number | null = null;
  private frameCount = 0;
  private rebuildTimer: ReturnType<typeof setInterval> | null = null;

  constructor(weather: WeatherManager) {
    this.weather = weather;

    for (let i = 0; i < NUM_WIND_PARTICLES; i++) {
      this.windTrailLon.push(new Float64Array(WIND_TRAIL_LENGTH));
      this.windTrailLat.push(new Float64Array(WIND_TRAIL_LENGTH));
      this.spawnWindParticle(i);
    }

    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });

    weather.on('dataLoaded', (d: any) => {
      console.log('[DeckLayers] dataLoaded event:', d);
      this.buildGlobalCloudDots();
      this.updateLayers();
    });
    weather.on('timeChange', () => this.updateLayers());
    weather.on('cloudLayersLoaded', (d: any) => {
      console.log('[DeckLayers] cloudLayersLoaded event:', d);
      this.buildGlobalCloudDots();
      this.updateLayers();
    });

    // Listen for background grid updates
    window.addEventListener('weather-grid-updated', () => {
      console.log('[DeckLayers] Grid updated event received — rebuilding');
      this.buildGlobalCloudDots();
      this.updateLayers();
    });

    // Periodically rebuild cloud dots in case data arrives late
    this.rebuildTimer = setInterval(() => {
      if (this.cloudDots.length === 0) {
        console.log('[DeckLayers] Attempting cloud dot rebuild...');
        this.buildGlobalCloudDots();
        if (this.cloudDots.length > 0) this.updateLayers();
      }
    }, 3000);
  }

  getControl(): MapboxOverlay { return this.overlay; }

  onMapReady(map: maplibregl.Map): void {
    this.map = map;

    loadRadarCells().then(() => this.updateLayers());
    this.buildGlobalCloudDots();
    this.startAnimation();

    map.on('move',   () => this.updateLayers());
    map.on('zoom',   () => this.updateLayers());
    map.on('rotate', () => this.updateLayers());
    map.on('pitch',  () => this.updateLayers());
  }

  setVisible(layer: 'clouds' | 'wind' | 'radar', visible: boolean): void {
    switch (layer) {
      case 'clouds':  this.cloudVisible = visible; break;
      case 'wind':    this.windVisible = visible; break;
      case 'radar':   this.radarVisible = visible; break;
    }
    this.updateLayers();
  }

  focusCity(city: City | null): void {
    this.focusedCity = city;
    this.updateLayers();
  }

  destroy(): void {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.rebuildTimer) clearInterval(this.rebuildTimer);
  }

  // ── Global 2D cloud dots from weather grid ──────────────────────────
  // This is the Windy-style confirmation that data is flowing.
  // Every grid cell with cloudFraction > 0.05 gets a colored dot.

  private buildGlobalCloudDots(): void {
    // Try cloud layers first, then fall back to surface grid
    const layers = this.weather.getCloudLayers();
    const grid = this.weather.getGrid('surface');

    // Debug: log what data we have
    console.log(`[CloudDots] Debug — layers: ${layers ? `yes (${layers.source}, ${layers.width}x${layers.height})` : 'null'}, grid: ${grid ? `yes (${grid.width}x${grid.height}, hasCF: ${!!grid.fields.cloudFraction})` : 'null'}`);

    let cloudData: Float32Array | null = null;
    let w = 360, h = 180;

    if (layers) {
      // Combine all 3 layers into one
      cloudData = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        cloudData[i] = Math.max(layers.low[i], layers.medium[i], layers.high[i]);
      }
      // Log some sample values
      const nonZero = cloudData.filter(v => v > 0.01).length;
      console.log(`[CloudDots] Using cloud layers (${layers.source}): ${nonZero}/${w*h} non-zero cells, sample: ${cloudData[0]}, ${cloudData[w*45+180]}`);
    } else if (grid?.fields.cloudFraction) {
      cloudData = grid.fields.cloudFraction;
      w = grid.width;
      h = grid.height;
      const nonZero = cloudData.filter(v => v > 0.01).length;
      console.log(`[CloudDots] Using surface grid: ${nonZero}/${w*h} non-zero cells, sample: ${cloudData[0]}, ${cloudData[w*45+180]}`);
    }

    if (!cloudData) {
      console.warn('[CloudDots] No cloud data available yet');
      this.cloudDots = [];
      return;
    }

    // Check data range
    let minVal = Infinity, maxVal = -Infinity, totalVal = 0;
    for (let i = 0; i < cloudData.length; i++) {
      if (cloudData[i] < minVal) minVal = cloudData[i];
      if (cloudData[i] > maxVal) maxVal = cloudData[i];
      totalVal += cloudData[i];
    }
    console.log(`[CloudDots] Data range: min=${minVal.toFixed(3)} max=${maxVal.toFixed(3)} avg=${(totalVal/cloudData.length).toFixed(3)}`);

    const dots: CloudDot[] = [];
    const cellLon = 360 / w;
    const cellLat = 180 / h;

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let cf = cloudData[j * w + i];
        if (cf > 1) cf /= 100; // normalize if percentage
        if (cf < 0.05) continue;

        const lon = (i / w) * 360 - 180 + cellLon * 0.5;
        const lat = 90 - (j / h) * 180 - cellLat * 0.5;

        // Color bin based on coverage
        const binIdx = Math.min(7, Math.floor(cf * 8));
        const [r, g, b, a] = CLOUD_COLORS[binIdx];

        // Radius scales with coverage — denser clouds = bigger dots
        const radius = 15000 + cf * 35000;

        dots.push({
          position: [lon, lat],
          color: [r, g, b, a],
          radius,
        });
      }
    }

    this.cloudDots = dots;
    console.log(`[CloudDots] ✅ ${dots.length} cloud cells rendered from ${w}x${h} grid`);
  }

  // ── Wind ────────────────────────────────────────────────────────────

  private spawnWindParticle(i: number): void {
    this.windLon[i] = (Math.random() - 0.5) * 360;
    this.windLat[i] = (Math.random() - 0.5) * 170;
    this.windAge[i] = Math.random() * 30;
    this.windTrailHead[i] = 0;
    for (let t = 0; t < WIND_TRAIL_LENGTH; t++) {
      this.windTrailLon[i][t] = this.windLon[i];
      this.windTrailLat[i][t] = this.windLat[i];
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
    return {
      u: bl(u[y0 * gw + x0], u[y0 * gw + x1], u[y1 * gw + x0], u[y1 * gw + x1]),
      v: bl(v[y0 * gw + x0], v[y0 * gw + x1], v[y1 * gw + x0], v[y1 * gw + x1]),
      get speed() { return Math.sqrt(this.u * this.u + this.v * this.v); },
    };
  }

  private advectAndBuildWind(): void {
    const wf = this.weather.getWindField('surface');
    if (!wf) { this.windData = []; return; }

    const { u, v } = wf;
    const trails: WindTrail[] = [];

    for (let i = 0; i < NUM_WIND_PARTICLES; i++) {
      this.windAge[i]++;
      if (this.windAge[i] > 80 + Math.random() * 60) {
        this.spawnWindParticle(i);
        continue;
      }

      const wind = this.sampleWind(u, v, this.windLon[i], this.windLat[i]);
      const spd = wind.speed;
      if (spd >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.windLat[i] * Math.PI / 180));
        const sf = Math.sqrt(spd);
        this.windLon[i] += (wind.u / spd) * sf * BASE_WIND_SPEED / cosLat;
        this.windLat[i] += (wind.v / spd) * sf * BASE_WIND_SPEED;
        if (this.windLon[i] > 180) this.windLon[i] -= 360;
        if (this.windLon[i] < -180) this.windLon[i] += 360;
        this.windLat[i] = Math.max(-85, Math.min(85, this.windLat[i]));
      }

      const head = this.windTrailHead[i];
      this.windTrailLon[i][head] = this.windLon[i];
      this.windTrailLat[i][head] = this.windLat[i];
      this.windTrailHead[i] = (head + 1) % WIND_TRAIL_LENGTH;

      if (this.windAge[i] < WIND_TRAIL_LENGTH || spd < 0.5) continue;

      let skip = false;
      for (let t = 0; t < WIND_TRAIL_LENGTH - 1; t++) {
        const s0 = (head + t) % WIND_TRAIL_LENGTH;
        const s1 = (head + t + 1) % WIND_TRAIL_LENGTH;
        if (Math.abs(this.windTrailLon[i][s1] - this.windTrailLon[i][s0]) > 15) {
          skip = true; break;
        }
      }
      if (skip) continue;

      const path: [number, number, number][] = [];
      for (let t = 0; t < WIND_TRAIL_LENGTH; t++) {
        const idx = (head + t) % WIND_TRAIL_LENGTH;
        path.push([this.windTrailLon[i][idx], this.windTrailLat[i][idx], 0]);
      }

      const bin = Math.min(7, Math.floor((spd / 25) * 8));
      const [r, g, b, a] = WIND_COLORS[bin];
      const fade = Math.min(1, this.windAge[i] / 10);
      trails.push({ path, color: [r, g, b, Math.round(a * fade)] });
    }

    this.windData = trails;
  }

  // ── Rain — generated from cloud coverage + humidity ──────────────────

  private tickRain(): void {
    // Try radar first
    const radarCells = getCachedRadarCells();

    // Also use weather data for rain generation
    const grid = this.weather.getGrid('surface');
    const cloudLayers = this.weather.getCloudLayers();

    // Spawn from radar
    if (radarCells.length > 0) {
      for (let i = 0; i < 80; i++) {
        const cell = radarCells[Math.floor(Math.random() * radarCells.length)];
        if (Math.random() > cell.intensity) continue;
        if (this.rainDrops.length >= 4000) break;

        this.rainDrops.push({
          lon: cell.lon + (Math.random() - 0.5) * 0.3,
          lat: cell.lat + (Math.random() - 0.5) * 0.2,
          elev: 800 + (1 - cell.intensity) * 2000,
          fallSpeed: 30 + Math.random() * 50 + cell.intensity * 25,
          intensity: cell.intensity,
          age: 0,
          maxAge: 50 + Math.floor(Math.random() * 50),
        });
      }
    }

    // Also spawn from weather grid — where cloud fraction AND humidity are high
    if (grid?.fields.cloudFraction && grid?.fields.humidity && this.rainDrops.length < 4000) {
      const cf = grid.fields.cloudFraction;
      const hum = grid.fields.humidity;
      const w = grid.width, h = grid.height;

      // Spawn ~100 random cells per frame, biased toward rainy areas
      for (let i = 0; i < 100; i++) {
        const gi = Math.floor(Math.random() * w);
        const gj = Math.floor(Math.random() * h);
        const idx = gj * w + gi;

        let coverage = cf[idx];
        if (coverage > 1) coverage /= 100;
        let humidity = hum[idx];
        if (humidity > 1) humidity /= 100;

        // Rain probability: high clouds + high humidity
        const rainProb = coverage * (humidity - 50) / 50; // humidity > 50% is rainy
        if (rainProb < 0.15) continue;
        if (Math.random() > rainProb) continue;

        const lon = (gi / w) * 360 - 180 + 0.5;
        const lat = 90 - (gj / h) * 180 - 0.5;

        this.rainDrops.push({
          lon: lon + (Math.random() - 0.5) * 0.5,
          lat: lat + (Math.random() - 0.5) * 0.3,
          elev: 600 + (1 - coverage) * 2200,
          fallSpeed: 25 + Math.random() * 45 + coverage * 20,
          intensity: Math.min(1, rainProb),
          age: 0,
          maxAge: 50 + Math.floor(Math.random() * 50),
        });
      }
    }

    // Update drops
    const drops: RainDrop[] = [];
    for (let i = this.rainDrops.length - 1; i >= 0; i--) {
      const d = this.rainDrops[i];
      d.age++;
      d.elev -= d.fallSpeed;

      if (d.elev <= 5 || d.age >= d.maxAge) {
        this.rainDrops[i] = this.rainDrops[this.rainDrops.length - 1];
        this.rainDrops.pop();
        continue;
      }

      const ageFade = d.age < 5 ? d.age / 5 : 1.0;
      const groundFade = d.elev < 150 ? d.elev / 150 : 1.0;
      const fade = ageFade * groundFade;

      const bin = Math.min(4, Math.floor(d.intensity * 5));
      const [r, g, b, a] = RAIN_COLORS[bin];

      drops.push({
        position: [d.lon, d.lat, d.elev],
        color: [r, g, b, Math.round(a * fade)],
        radius: 800 + d.intensity * 2000,
      });
    }

    this.rainData = drops;
  }

  // ── Animation ───────────────────────────────────────────────────────

  private startAnimation(): void {
    let lastFrame = 0;
    let lastRadarRefresh = 0;
    const tick = (now: number) => {
      if (now - lastFrame > 66) {
        lastFrame = now;
        this.frameCount++;
        this.advectAndBuildWind();
        this.tickRain();

        if (now - lastRadarRefresh > 5 * 60 * 1000) {
          lastRadarRefresh = now;
          loadRadarCells();
        }

        this.updateLayers();
      }
      this.animId = requestAnimationFrame(tick);
    };
    this.animId = requestAnimationFrame(tick);
  }

  // ── Layer composition ───────────────────────────────────────────────

  private updateLayers(): void {
    const layers: any[] = [];

    // ── Global 2D Cloud Coverage (Windy-style) ──────────────────────
    // CONFIRMS DATA IS FLOWING — colored dots for every cloudy grid cell
    if (this.cloudVisible && this.cloudDots.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'global-cloud-dots',
        data: this.cloudDots,
        getPosition: (d: CloudDot) => d.position,
        getRadius: (d: CloudDot) => d.radius,
        getFillColor: (d: CloudDot) => d.color,
        radiusUnits: 'meters',
        radiusMinPixels: 2,
        radiusMaxPixels: 30,
        opacity: 1.0,
        pickable: false,
        transitions: {
          getFillColor: { duration: 1000 },
        },
      }));
    }

    // ── Rain — ScatterplotLayer (global from weather data + radar) ──
    if (this.radarVisible && this.rainData.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'rain-drops',
        data: this.rainData,
        getPosition: (d: RainDrop) => d.position,
        getRadius: (d: RainDrop) => d.radius,
        getFillColor: (d: RainDrop) => d.color,
        radiusUnits: 'meters',
        radiusMinPixels: 1,
        radiusMaxPixels: 6,
        opacity: 0.8,
        pickable: false,
      }));
    }

    // ── Wind — denser particles ─────────────────────────────────────
    if (this.windVisible && this.windData.length > 0) {
      layers.push(new PathLayer({
        id: 'wind-trails',
        data: this.windData,
        getPath: (d: WindTrail) => d.path,
        getColor: (d: WindTrail) => d.color,
        getWidth: 2.5,
        widthUnits: 'pixels',
        opacity: 0.85,
        pickable: false,
        capRounded: true,
        jointRounded: true,
      }));
    }

    this.overlay.setProps({ layers });
  }
}
