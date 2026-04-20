/**
 * DeckLayers — Weather visualization using deck.gl layers.
 *
 * Clouds: PointCloudLayer (3D lit spheres, not flat circles)
 * Wind:   PathLayer (multi-segment particle trails)
 * Rain:   ScatterplotLayer (small flat drops)
 *
 * References:
 * - deck.gl/examples/point-cloud → PointCloudLayer with sizeUnits:'meters' + material
 * - deck.gl/examples/maplibre    → MapboxOverlay as MapLibre IControl
 * - deck.gl/examples/globe       → [lon, lat, altitude] positioning
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { PointCloudLayer, ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { WeatherManager } from './WeatherManager';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface CloudPoint {
  position: [number, number, number]; // lon, lat, altitude(m)
  normal: [number, number, number];   // surface normal for lighting
  color: [number, number, number];
}

interface WindTrail {
  path: [number, number, number][];
  color: [number, number, number, number];
}

interface RainDrop {
  position: [number, number, number];
  color: [number, number, number];
  radius: number;
}

interface City {
  name: string;
  lon: number;
  lat: number;
}

// ── Constants ─────────────────────────────────────────────────────────

const NUM_WIND_PARTICLES = 5000;
const WIND_TRAIL_LENGTH = 8;
const BASE_WIND_SPEED = 0.005;

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

// Cloud bands: altitude, point size (meters), color tint, opacity
const CLOUD_BANDS = [
  { alt: 800,   spread: 500,  pointSize: 800,  color: [248, 248, 255] as [number, number, number], opacity: 0.65 },
  { alt: 1600,  spread: 700,  pointSize: 1200, color: [240, 242, 252] as [number, number, number], opacity: 0.50 },
  { alt: 3000,  spread: 1000, pointSize: 1800, color: [232, 236, 248] as [number, number, number], opacity: 0.40 },
  { alt: 5000,  spread: 1400, pointSize: 2500, color: [222, 228, 245] as [number, number, number], opacity: 0.30 },
  { alt: 8000,  spread: 2000, pointSize: 3500, color: [212, 220, 242] as [number, number, number], opacity: 0.22 },
  { alt: 11000, spread: 2500, pointSize: 5000, color: [200, 210, 238] as [number, number, number], opacity: 0.15 },
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
  private cloudData: CloudPoint[][] = []; // one array per band

  // Wind state
  private windLon = new Float64Array(NUM_WIND_PARTICLES);
  private windLat = new Float64Array(NUM_WIND_PARTICLES);
  private windAge = new Float32Array(NUM_WIND_PARTICLES);
  private windTrailLon: Float64Array[] = [];
  private windTrailLat: Float64Array[] = [];
  private windTrailHead = new Uint16Array(NUM_WIND_PARTICLES);

  private windData: WindTrail[] = [];
  private rainData: RainDrop[] = [];

  private animId: number | null = null;
  private frameCount = 0;

  constructor(weather: WeatherManager) {
    this.weather = weather;

    for (let i = 0; i < NUM_WIND_PARTICLES; i++) {
      this.windTrailLon.push(new Float64Array(WIND_TRAIL_LENGTH));
      this.windTrailLat.push(new Float64Array(WIND_TRAIL_LENGTH));
      this.spawnWindParticle(i);
    }

    this.overlay = new MapboxOverlay({ interleaved: true, layers: [] });

    weather.on('dataLoaded', () => this.updateLayers());
    weather.on('timeChange', () => this.updateLayers());
  }

  getControl(): MapboxOverlay { return this.overlay; }

  onMapReady(map: maplibregl.Map): void {
    this.map = map;
    this.startAnimation();

    // Re-render on map interaction so deck.gl stays synced
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
    if (city) {
      this.generateVolumetricClouds(city);
    } else {
      this.cloudData = [];
    }
    this.updateLayers();
  }

  destroy(): void {
    if (this.animId) cancelAnimationFrame(this.animId);
  }

  // ── Volumetric cloud generation (reference: point-cloud example) ────

  private generateVolumetricClouds(city: City): void {
    const bands: CloudPoint[][] = [];
    const regionRadius = 0.7; // degrees
    const gridStep = 0.025;   // ~2.5km grid

    for (let bi = 0; bi < CLOUD_BANDS.length; bi++) {
      const cfg = CLOUD_BANDS[bi];
      const density = 1 - bi * 0.1;
      const points: CloudPoint[] = [];

      for (let dy = -regionRadius; dy <= regionRadius; dy += gridStep) {
        for (let dx = -regionRadius; dx <= regionRadius; dx += gridStep) {
          // Procedural cloud coverage — layered noise
          const nx = (city.lon + dx) * 3.7;
          const ny = (city.lat + dy) * 4.1;
          const coverage =
            (Math.sin(nx * 1.0 + ny * 0.7) * 0.5 + 0.5) *
            (Math.sin(nx * 2.3 - ny * 1.9) * 0.5 + 0.5) *
            (Math.cos(nx * 0.7 + ny * 2.1) * 0.5 + 0.5) *
            (Math.sin((nx + ny) * 0.5) * 0.3 + 0.7);

          const dist = Math.sqrt(dx * dx + dy * dy) / regionRadius;
          const edgeFade = Math.max(0, 1 - dist * dist);
          const c = coverage * edgeFade * density;
          if (c < 0.12) continue;

          // Random normal for lighting variation (simulates cloud surface bumps)
          const normalAngle = Math.random() * Math.PI * 2;
          const normalTilt = (Math.random() - 0.5) * 0.6;
          const nx2 = Math.cos(normalAngle) * Math.cos(normalTilt);
          const ny2 = Math.sin(normalAngle) * Math.cos(normalTilt);
          const nz = 0.8 + Math.sin(normalTilt) * 0.2; // mostly upward

          const alt = cfg.alt + (Math.random() - 0.5) * cfg.spread;

          // Color: brighter in dense center, darker at edges
          const bright = 0.85 + c * 0.15;
          const edge = Math.min(1, dist * 1.5);
          points.push({
            position: [
              city.lon + dx + (Math.random() - 0.5) * gridStep,
              city.lat + dy + (Math.random() - 0.5) * gridStep,
              Math.max(50, alt),
            ],
            normal: [nx2, ny2, nz],
            color: [
              Math.round(cfg.color[0] * bright - edge * 12),
              Math.round(cfg.color[1] * bright - edge * 10),
              Math.round(cfg.color[2] * bright - edge * 5),
            ],
          });
        }
      }

      bands.push(points);
    }

    this.cloudData = bands;
    const total = bands.reduce((s, b) => s + b.length, 0);
    console.log(`[DeckClouds] ${total} volumetric points for ${city.name} across ${CLOUD_BANDS.length} bands`);
  }

  // ── Wind (reference: globe example — path-based animation) ──────────

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

      // Skip dateline wrapping
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

  // ── Rain ────────────────────────────────────────────────────────────

  private buildRainData(): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) { this.rainData = []; return; }
    const { fields } = grid;
    if (!fields?.cloudFraction || !fields?.humidity) { this.rainData = []; return; }

    const { cloudFraction, humidity } = fields;
    const w = 360, h = 180;
    const drops: RainDrop[] = [];

    for (let j = 0; j < h; j += 6) {
      for (let i = 0; i < w; i += 6) {
        let cf = cloudFraction[j * w + i];
        const hum = humidity[j * w + i];
        if (cf > 1) cf /= 100;
        if (cf < 0.5 || hum < 65) continue;

        const intensity = (cf - 0.5) * 2 * Math.max(0, (hum - 65) / 35);
        if (intensity < 0.1) continue;

        const lon = (i / w) * 360 - 180 + (Math.random() - 0.5) * 3;
        const lat = 90 - (j / h) * 180 + (Math.random() - 0.5) * 2;
        const bin = Math.min(4, Math.floor(intensity * 5));
        const [r, g, b] = RAIN_COLORS[bin];

        drops.push({
          position: [lon, lat, 0],
          color: [r, g, b],
          radius: 2000 + intensity * 5000,
        });
      }
    }

    this.rainData = drops;
  }

  // ── Animation ───────────────────────────────────────────────────────

  private startAnimation(): void {
    let lastFrame = 0;
    const tick = (now: number) => {
      if (now - lastFrame > 66) { // ~15fps
        lastFrame = now;
        this.frameCount++;
        this.advectAndBuildWind();
        if (this.frameCount % 3 === 0) this.buildRainData();
        this.updateLayers();
      }
      this.animId = requestAnimationFrame(tick);
    };
    this.animId = requestAnimationFrame(tick);
  }

  // ── Layer composition ───────────────────────────────────────────────

  private updateLayers(): void {
    const layers: any[] = [];

    // Rain — ScatterplotLayer (flat circles, fast)
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
        radiusMaxPixels: 10,
        pickable: false,
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
      }));
    }

    // Volumetric clouds — PointCloudLayer per band (3D lit spheres)
    // Reference: deck.gl/examples/point-cloud
    //   PointCloudLayer with sizeUnits:'meters', pointSize, material, getNormal
    if (this.cloudVisible && this.cloudData.length > 0) {
      for (let bi = 0; bi < CLOUD_BANDS.length; bi++) {
        const cfg = CLOUD_BANDS[bi];
        const points = this.cloudData[bi];
        if (!points || points.length === 0) continue;

        layers.push(new PointCloudLayer({
          id: `deck-clouds-${bi}`,
          data: points,
          getPosition: (d: CloudPoint) => d.position,
          getNormal: (d: CloudPoint) => d.normal,
          getColor: (d: CloudPoint) => d.color,
          pointSize: cfg.pointSize,
          sizeUnits: 'meters',
          opacity: cfg.opacity,
          pickable: false,
          // Phong-like material for volumetric lighting
          material: {
            ambient: 0.6,
            diffuse: 0.7,
            shininess: 20,
            specularColor: [200, 200, 210],
          },
        }));
      }
    }

    this.overlay.setProps({ layers });
  }
}
