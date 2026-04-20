/**
 * DeckLayers — Weather visualization using deck.gl layers.
 *
 * Clouds: PointCloudLayer (3D lit spheres, data-driven density + storm shaping)
 * Wind:   PathLayer (multi-segment particle trails)
 * Rain:   PathLayer (vertical elevation-based streaks from cloud to ground)
 *
 * References:
 * - deck.gl/examples/point-cloud → PointCloudLayer with sizeUnits:'meters' + material
 * - deck.gl/examples/maplibre    → MapboxOverlay as MapLibre IControl
 * - deck.gl/examples/globe       → [lon, lat, altitude] positioning
 */

import { MapboxOverlay } from '@deck.gl/mapbox';
import { PointCloudLayer, ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import type { WeatherManager } from './WeatherManager';
import { loadRadarCells, getCachedRadarCells } from './RadarData';
import { generateCloudNoise, generateHeightNoise, generateStormNoise } from './CloudNoise';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface CloudPoint {
  position: [number, number, number]; // lon, lat, altitude(m)
  normal: [number, number, number];   // surface normal for lighting
  color: [number, number, number, number]; // rgba
}

interface WindTrail {
  path: [number, number, number][];
  color: [number, number, number, number];
}

interface RainStreak {
  path: [number, number, number][]; // top → bottom (same lon/lat, descending elev)
  color: [number, number, number, number];
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

const RAIN_COLORS: [number, number, number, number][] = [
  [90, 140, 210, 160],
  [130, 180, 235, 190],
  [170, 215, 255, 210],
  [210, 235, 255, 230],
  [245, 250, 255, 240],
];

/**
 * Cloud bands — SMALLER points, MORE of them, proper altitude mapping.
 * Altitude spread defines vertical extent of cloud column.
 * Point size is in meters (sizeUnits:'meters') — kept small for density illusion.
 */
interface CloudBand {
  alt: number;
  spread: number;
  /** Point size in meters — SMALLER for denser look */
  pointSize: number;
  color: [number, number, number];
  opacity: number;
  /** Cloud type for shape variation */
  type: 'cumulus' | 'anvil' | 'stratus' | 'cirrus';
}

const CLOUD_BANDS: CloudBand[] = [
  // Low cumulus — the classic puffy clouds
  { alt: 600,  spread: 600,  pointSize: 300,  color: [248, 248, 255], opacity: 0.70, type: 'cumulus' },
  { alt: 1200, spread: 800,  pointSize: 450,  color: [244, 245, 254], opacity: 0.60, type: 'cumulus' },
  // Storm anvil layer — wide flat tops, dense
  { alt: 1800, spread: 1500, pointSize: 600,  color: [200, 205, 218], opacity: 0.75, type: 'anvil' },
  // Medium stratus — flat, layered
  { alt: 3500, spread: 1200, pointSize: 500,  color: [230, 234, 248], opacity: 0.45, type: 'stratus' },
  { alt: 5500, spread: 1800, pointSize: 700,  color: [220, 226, 244], opacity: 0.35, type: 'stratus' },
  // High cirrus — thin, wispy, translucent
  { alt: 8000, spread: 2500, pointSize: 800,  color: [208, 216, 240], opacity: 0.20, type: 'cirrus' },
  { alt: 10500, spread: 3000, pointSize: 1000, color: [196, 206, 236], opacity: 0.12, type: 'cirrus' },
];

// ── Rain streak state ─────────────────────────────────────────────────

interface RainDropState {
  lon: number;
  lat: number;
  elev: number;       // current elevation (falls from cloud base to ground)
  cloudBase: number;  // spawn altitude
  fallSpeed: number;  // meters per frame
  streakLen: number;  // streak length in meters
  intensity: number;
  age: number;
  maxAge: number;
  driftLon: number;
  driftLat: number;
}

const MAX_RAIN_DROPS = 4000;
const RAIN_SPAWN_PER_TICK = 100;
const CLOUD_BASE_MIN = 600;
const CLOUD_BASE_MAX = 2800;
const GROUND_ELEV = 5;

// ── Main class ────────────────────────────────────────────────────────

export class DeckLayers {
  private overlay: MapboxOverlay;
  private weather: WeatherManager;
  private map: maplibregl.Map | null = null;

  private cloudVisible = true;
  private windVisible = true;
  private radarVisible = true;

  private focusedCity: City | null = null;
  private cloudData: CloudPoint[][] = [];

  // Wind state
  private windLon = new Float64Array(NUM_WIND_PARTICLES);
  private windLat = new Float64Array(NUM_WIND_PARTICLES);
  private windAge = new Float32Array(NUM_WIND_PARTICLES);
  private windTrailLon: Float64Array[] = [];
  private windTrailLat: Float64Array[] = [];
  private windTrailHead = new Uint16Array(NUM_WIND_PARTICLES);

  private windData: WindTrail[] = [];

  // Rain state — elevation-based drops
  private rainDrops: RainDropState[] = [];
  private rainData: RainStreak[] = [];

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

    loadRadarCells().then(() => {
      this.updateLayers();
    });

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

  // ── Volumetric cloud generation ──────────────────────────────────────
  // Noise-driven, storm-aware, with proper altitude bands.
  // MORE smaller particles for denser, more realistic look.

  private generateVolumetricClouds(city: City): void {
    const seed = Math.round(city.lon * 7 + city.lat * 13) % 1000;
    const noiseW = 256, noiseH = 128;
    const cloudNoise = generateCloudNoise(noiseW, noiseH, seed);
    const heightNoise = generateHeightNoise(noiseW, noiseH, seed + 33);
    const stormNoise = generateStormNoise(noiseW, noiseH, seed + 77);

    const bands: CloudPoint[][] = CLOUD_BANDS.map(() => []);
    const regionRadius = 0.8; // LARGER coverage area
    const gridStep = 0.01;    // finer grid → more particles

    for (let dy = -regionRadius; dy <= regionRadius; dy += gridStep) {
      for (let dx = -regionRadius; dx <= regionRadius; dx += gridStep) {
        const nu = (dx / regionRadius + 1) * 0.5;
        const nv = (dy / regionRadius + 1) * 0.5;
        const ni = Math.floor(nu * (noiseW - 1));
        const nj = Math.floor(nv * (noiseH - 1));
        const noiseIdx = nj * noiseW + ni;
        const noiseVal = cloudNoise[noiseIdx];
        const hVal = heightNoise[noiseIdx];
        const stormVal = stormNoise[noiseIdx];

        if (noiseVal < 0.05) continue;

        const dist = Math.sqrt(dx * dx + dy * dy) / regionRadius;
        const edgeFade = Math.max(0, 1 - dist * dist);
        const cloudDensity = noiseVal * edgeFade;
        if (cloudDensity < 0.05) continue;

        // Height profile: how tall this cloud column is
        const maxBand = Math.ceil((0.3 + hVal * 0.7) * CLOUD_BANDS.length);

        for (let bi = 0; bi < Math.min(maxBand, CLOUD_BANDS.length); bi++) {
          const cfg = CLOUD_BANDS[bi];

          // Anvil band: only where storm intensity is high
          if (cfg.type === 'anvil' && stormVal < 0.2) continue;

          let effectiveDensity = cloudDensity;
          if (cfg.type === 'anvil') {
            effectiveDensity *= stormVal * 1.5;
          }

          if (effectiveDensity < 0.04) continue;

          // MORE particles, SMALLER — higher density multiplier
          const densityMul = cfg.type === 'cirrus' ? 2 : 4;
          const numPts = Math.max(1, Math.ceil(effectiveDensity * densityMul));

          for (let p = 0; p < numPts; p++) {
            const jitterX = (Math.random() - 0.5) * gridStep * 1.3;
            const jitterY = (Math.random() - 0.5) * gridStep * 1.3;

            // Altitude modulation by height noise
            const heightMod = cfg.type === 'anvil'
              ? 1.0 + hVal * 0.6
              : 0.7 + hVal * 0.3;
            const altBase = cfg.alt * heightMod;
            const altSpread = cfg.spread * heightMod;
            const alt = altBase + (Math.random() - 0.5) * altSpread;

            const angle = Math.random() * Math.PI * 2;
            const tilt = (Math.random() - 0.5) * 0.4;

            // Color: storm clouds darker, normal clouds brighter
            let brightness = 0.85 + effectiveDensity * 0.15;
            const alpha = cfg.opacity * (0.6 + effectiveDensity * 0.4);
            if (cfg.type === 'anvil') {
              brightness *= 0.7; // storm clouds are darker
            }

            bands[bi].push({
              position: [
                city.lon + dx + jitterX,
                city.lat + dy + jitterY,
                Math.max(20, alt),
              ],
              normal: [
                Math.cos(angle) * Math.cos(tilt),
                Math.sin(angle) * Math.cos(tilt),
                0.75 + Math.sin(tilt) * 0.25,
              ],
              color: [
                Math.round(cfg.color[0] * brightness),
                Math.round(cfg.color[1] * brightness),
                Math.round(cfg.color[2] * brightness),
                Math.round(alpha * 255),
              ],
            });
          }
        }
      }
    }

    this.cloudData = bands;
    const total = bands.reduce((s, b) => s + b.length, 0);
    console.log(`[DeckClouds] ${total} pts for ${city.name} across ${CLOUD_BANDS.length} bands`);
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

  // ── Rain — vertical streaks from cloud base to ground ────────────────

  private tickRain(): void {
    const cells = getCachedRadarCells();

    // Spawn new drops from radar cells
    if (cells.length > 0) {
      for (let i = 0; i < RAIN_SPAWN_PER_TICK; i++) {
        const cell = cells[Math.floor(Math.random() * cells.length)];
        if (Math.random() > cell.intensity) continue;
        if (this.rainDrops.length >= MAX_RAIN_DROPS) break;

        const cloudBase = CLOUD_BASE_MIN + (1 - cell.intensity) * (CLOUD_BASE_MAX - CLOUD_BASE_MIN);

        this.rainDrops.push({
          lon: cell.lon + (Math.random() - 0.5) * 0.3,
          lat: cell.lat + (Math.random() - 0.5) * 0.2,
          elev: cloudBase,
          cloudBase,
          fallSpeed: 30 + Math.random() * 50 + cell.intensity * 25,
          streakLen: 80 + Math.random() * 150 + cell.intensity * 120,
          intensity: cell.intensity,
          age: 0,
          maxAge: 50 + Math.floor(Math.random() * 50),
          driftLon: (Math.random() - 0.5) * 0.0008,
          driftLat: (Math.random() - 0.5) * 0.0004,
        });
      }
    }

    // Update drops and build streaks
    const streaks: RainStreak[] = [];

    for (let i = this.rainDrops.length - 1; i >= 0; i--) {
      const d = this.rainDrops[i];
      d.age++;
      d.elev -= d.fallSpeed;
      d.lon += d.driftLon;
      d.lat += d.driftLat;

      if (d.elev <= GROUND_ELEV || d.age >= d.maxAge) {
        this.rainDrops[i] = this.rainDrops[this.rainDrops.length - 1];
        this.rainDrops.pop();
        continue;
      }
      if (Math.abs(d.lat) > 85) continue;

      // Vertical streak: same lon/lat, elevation descends
      const topElev = d.elev + d.streakLen;
      const botElev = d.elev;

      const ageFade = d.age < 5 ? d.age / 5 : 1.0;
      const groundFade = botElev < 150 ? botElev / 150 : 1.0;
      const fade = ageFade * groundFade;

      const bin = Math.min(4, Math.floor(d.intensity * 5));
      const [r, g, b, a] = RAIN_COLORS[bin];

      streaks.push({
        path: [
          [d.lon, d.lat, topElev],
          [d.lon, d.lat, botElev],
        ],
        color: [r, g, b, Math.round(a * fade)],
      });
    }

    this.rainData = streaks;
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

        // Refresh radar every 5 minutes
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

    // Rain — vertical streaks via PathLayer (same lon/lat, descending elevation)
    if (this.radarVisible && this.rainData.length > 0) {
      layers.push(new PathLayer({
        id: 'deck-rain',
        data: this.rainData,
        getPath: (d: RainStreak) => d.path,
        getColor: (d: RainStreak) => d.color,
        getWidth: 1.5,
        widthUnits: 'pixels',
        opacity: 0.85,
        pickable: false,
        capRounded: true,
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

    // Clouds — PointCloudLayer per band
    // SMALLER points + MORE bands = denser, more realistic cloud mass
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
          getColor: (d: CloudPoint) => [d.color[0], d.color[1], d.color[2]],
          pointSize: cfg.pointSize,
          sizeUnits: 'meters',
          opacity: cfg.opacity,
          pickable: false,
          material: {
            ambient: cfg.type === 'anvil' ? 0.4 : 0.6,
            diffuse: cfg.type === 'anvil' ? 0.5 : 0.7,
            shininess: cfg.type === 'cirrus' ? 10 : 20,
            specularColor: [200, 200, 210],
          },
        }));
      }
    }

    this.overlay.setProps({ layers });
  }
}
