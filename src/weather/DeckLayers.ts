/**
 * DeckLayers — Weather visualization using deck.gl layers.
 *
 * Global view: wind particle trails + rain scatter.
 * City focus: volumetric cloud particles (multiple altitude bands, overlapping).
 *
 * Uses MapboxOverlay (deck.gl) + MapLibre (flat mercator).
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { WeatherManager } from './WeatherManager';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface CloudParticle {
  position: [number, number, number]; // lon, lat, altitude(m)
  radius: number;
  color: [number, number, number];
  opacity: number;
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
const WIND_TRAIL_LENGTH = 6;
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

// Cloud altitude bands for volumetric effect
const CLOUD_BANDS = [
  { name: 'low',     alt: 800,   spread: 600,  baseColor: [250, 250, 255] as [number, number, number], baseRadius: 400,  opacity: 0.55 },
  { name: 'mid-low', alt: 1800,  spread: 800,  baseColor: [240, 242, 250] as [number, number, number], baseRadius: 600,  opacity: 0.45 },
  { name: 'mid',     alt: 3200,  spread: 1200, baseColor: [230, 234, 245] as [number, number, number], baseRadius: 800,  opacity: 0.38 },
  { name: 'mid-high',alt: 5000,  spread: 1500, baseColor: [220, 226, 242] as [number, number, number], baseRadius: 1000, opacity: 0.30 },
  { name: 'high',    alt: 7500,  spread: 2000, baseColor: [210, 218, 240] as [number, number, number], baseRadius: 1200, opacity: 0.22 },
  { name: 'cirrus',  alt: 10000, spread: 2500, baseColor: [200, 210, 238] as [number, number, number], baseRadius: 1800, opacity: 0.15 },
];

// ── Main class ────────────────────────────────────────────────────────

export class DeckLayers {
  private overlay: MapboxOverlay;
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;

  private cloudVisible = true;
  private windVisible = true;
  private radarVisible = true;

  // State
  private focusedCity: City | null = null;
  private cloudParticles: CloudParticle[] = [];

  // Wind particles
  private windLon = new Float64Array(NUM_WIND_PARTICLES);
  private windLat = new Float64Array(NUM_WIND_PARTICLES);
  private windAge = new Float32Array(NUM_WIND_PARTICLES);
  private windTrailLon: Float64Array[] = [];
  private windTrailLat: Float64Array[] = [];
  private windTrailHead = new Uint16Array(NUM_WIND_PARTICLES);

  // Cached
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

    // Re-render on any map interaction
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

  /** Focus on a city — generate volumetric clouds in that area */
  focusCity(city: City | null): void {
    this.focusedCity = city;
    if (city) {
      this.generateVolumetricClouds(city);
    } else {
      this.cloudParticles = [];
    }
    this.updateLayers();
  }

  destroy(): void {
    if (this.animId) cancelAnimationFrame(this.animId);
  }

  // ── Volumetric cloud generation ─────────────────────────────────────

  private generateVolumetricClouds(city: City): void {
    const particles: CloudParticle[] = [];
    const regionSize = 0.8; // degrees around city center
    const gridStep = 0.03;  // ~3km grid

    // Generate a procedural cloud field using Perlin-like noise
    for (let band = 0; band < CLOUD_BANDS.length; band++) {
      const cfg = CLOUD_BANDS[band];
      const density = 1 - band * 0.12; // denser at low altitudes

      for (let dy = -regionSize; dy <= regionSize; dy += gridStep) {
        for (let dx = -regionSize; dx <= regionSize; dx += gridStep) {
          // Procedural coverage using overlapping sine waves
          const nx = (city.lon + dx) * 3.7;
          const ny = (city.lat + dy) * 4.1;
          const coverage =
            (Math.sin(nx * 1.0 + ny * 0.7) * 0.5 + 0.5) *
            (Math.sin(nx * 2.3 - ny * 1.9) * 0.5 + 0.5) *
            (Math.cos(nx * 0.7 + ny * 2.1) * 0.5 + 0.5) *
            (Math.sin((nx + ny) * 0.5) * 0.3 + 0.7);

          // Edge falloff — clouds thin out at region edges
          const dist = Math.sqrt(dx * dx + dy * dy) / regionSize;
          const edgeFade = Math.max(0, 1 - dist * dist);

          const c = coverage * edgeFade * density;
          if (c < 0.15) continue;

          // Multiple particles per cell for volume
          const numPts = Math.ceil(c * 3);
          for (let p = 0; p < numPts; p++) {
            const jitterX = (Math.random() - 0.5) * gridStep * 1.2;
            const jitterY = (Math.random() - 0.5) * gridStep * 1.2;
            const alt = cfg.alt + (Math.random() - 0.5) * cfg.spread;
            const sizeJitter = 0.6 + Math.random() * 0.8;

            // Color: whiter in center, bluer at edges
            const edge = Math.min(1, dist * 1.5);
            const r = Math.round(cfg.baseColor[0] - edge * 15);
            const g = Math.round(cfg.baseColor[1] - edge * 12);
            const b = Math.round(cfg.baseColor[2] - edge * 5);

            particles.push({
              position: [city.lon + dx + jitterX, city.lat + dy + jitterY, Math.max(50, alt)],
              radius: cfg.baseRadius * c * sizeJitter,
              color: [r, g, b],
              opacity: cfg.opacity * c,
            });
          }
        }
      }
    }

    this.cloudParticles = particles;
    console.log(`[DeckClouds] ${particles.length} volumetric particles for ${city.name}`);
  }

  // ── Wind particles ──────────────────────────────────────────────────

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
    const uVal = bl(u[y0 * gw + x0], u[y0 * gw + x1], u[y1 * gw + x0], u[y1 * gw + x1]);
    const vVal = bl(v[y0 * gw + x0], v[y0 * gw + x1], v[y1 * gw + x0], v[y1 * gw + x1]);
    return { u: uVal, v: vVal, speed: Math.sqrt(uVal * uVal + vVal * vVal) };
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
      if (wind.speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.windLat[i] * Math.PI / 180));
        const sf = Math.sqrt(wind.speed);
        this.windLon[i] += (wind.u / wind.speed) * sf * BASE_WIND_SPEED / cosLat;
        this.windLat[i] += (wind.v / wind.speed) * sf * BASE_WIND_SPEED;
        if (this.windLon[i] > 180) this.windLon[i] -= 360;
        if (this.windLon[i] < -180) this.windLon[i] += 360;
        this.windLat[i] = Math.max(-85, Math.min(85, this.windLat[i]));
      }

      const head = this.windTrailHead[i];
      this.windTrailLon[i][head] = this.windLon[i];
      this.windTrailLat[i][head] = this.windLat[i];
      this.windTrailHead[i] = (head + 1) % WIND_TRAIL_LENGTH;

      if (this.windAge[i] < WIND_TRAIL_LENGTH || wind.speed < 0.5) continue;

      // Check for dateline wrapping
      let breakFlag = false;
      for (let t = 0; t < WIND_TRAIL_LENGTH - 1; t++) {
        const s0 = (head + t) % WIND_TRAIL_LENGTH;
        const s1 = (head + t + 1) % WIND_TRAIL_LENGTH;
        if (Math.abs(this.windTrailLon[i][s1] - this.windTrailLon[i][s0]) > 15) {
          breakFlag = true; break;
        }
      }
      if (breakFlag) continue;

      const path: [number, number, number][] = [];
      for (let t = 0; t < WIND_TRAIL_LENGTH; t++) {
        const idx = (head + t) % WIND_TRAIL_LENGTH;
        path.push([this.windTrailLon[i][idx], this.windTrailLat[i][idx], 0]);
      }

      const bin = Math.min(7, Math.floor((wind.speed / 25) * 8));
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
          radius: 3000 + intensity * 6000,
        });
      }
    }

    this.rainData = drops;
  }

  // ── Animation ───────────────────────────────────────────────────────

  private startAnimation(): void {
    let lastFrame = 0;
    const tick = (now: number) => {
      if (now - lastFrame > 66) {
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

    // Rain (global)
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

    // Wind (global)
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

    // Volumetric clouds (city focus only)
    if (this.cloudVisible && this.cloudParticles.length > 0) {
      // Create one ScatterplotLayer per altitude band for proper depth sorting
      for (let band = 0; band < CLOUD_BANDS.length; band++) {
        const cfg = CLOUD_BANDS[band];
        const bandParticles = this.cloudParticles.filter(
          (_, idx) => idx % CLOUD_BANDS.length === band
        );
        if (bandParticles.length === 0) continue;

        layers.push(new ScatterplotLayer({
          id: `deck-clouds-${cfg.name}`,
          data: bandParticles,
          getPosition: (d: CloudParticle) => d.position,
          getRadius: (d: CloudParticle) => d.radius,
          getFillColor: (d: CloudParticle) => d.color,
          opacity: cfg.opacity,
          radiusUnits: 'meters',
          radiusMinPixels: 3,
          radiusMaxPixels: 80,
          pickable: false,
          // Blend mode: additive for that soft volumetric overlap
          parameters: {
            blendFunc: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA'],
            blendEquation: 'FUNC_ADD',
          },
        }));
      }
    }

    this.overlay.setProps({ layers });
  }
}
