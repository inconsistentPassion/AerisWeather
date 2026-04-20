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
import { ScatterplotLayer, PathLayer, PointCloudLayer } from '@deck.gl/layers';
import type { WeatherManager } from './WeatherManager';
import { loadRadarCells, getCachedRadarCells } from './RadarData';
import { generateCloudNoise, generateHeightNoise, generateStormNoise } from './CloudNoise';
import type maplibregl from 'maplibre-gl';

// ── Types ─────────────────────────────────────────────────────────────

interface WindTrail {
  path: [number, number, number][];
  color: [number, number, number, number];
}

interface RainStreak {
  path: [number, number, number][];
  color: [number, number, number, number];
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
  [220, 225, 240, 60],   // < 0.1 — light haze
  [210, 215, 235, 100],  // 0.1-0.25
  [195, 205, 230, 140],  // 0.25-0.4
  [180, 190, 225, 180],  // 0.4-0.55
  [160, 175, 220, 210],  // 0.55-0.7
  [140, 160, 215, 235],  // 0.7-0.85
  [120, 145, 210, 250],  // 0.85-0.95
  [100, 130, 205, 255],  // > 0.95 — fully opaque
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

  // Rain — generated from weather data (vertical streaks)
  private rainDrops: Array<{
    lon: number; lat: number;
    elev: number; fallSpeed: number; streakLen: number;
    intensity: number; age: number; maxAge: number;
  }> = [];
  private rainData: RainStreak[] = [];

  // Cloud dots — global 2D visualization
  private cloudDots: CloudDot[] = [];

  // Volumetric 3D clouds — city focus mode
  private volumetricClouds: Array<{
    position: [number, number, number];
    normal: [number, number, number];
    color: [number, number, number];
    bandIdx: number;
  }> = [];

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
    if (city) {
      this.generateVolumetricClouds(city);
    } else {
      this.volumetricClouds = [];
    }
    this.updateLayers();
  }

  destroy(): void {
    if (this.animId) cancelAnimationFrame(this.animId);
    if (this.rebuildTimer) clearInterval(this.rebuildTimer);
  }

  // ── Volumetric 3D clouds for city focus ──────────────────────────────

  private generateVolumetricClouds(city: City): void {
    const seed = Math.round(city.lon * 7 + city.lat * 13) % 1000;
    const noiseW = 256, noiseH = 128;
    const cloudNoise = generateCloudNoise(noiseW, noiseH, seed);
    const heightNoise = generateHeightNoise(noiseW, noiseH, seed + 33);
    const stormNoise = generateStormNoise(noiseW, noiseH, seed + 77);

    const points: typeof this.volumetricClouds = [];
    const regionRadius = 0.8;
    const gridStep = 0.008;

    // Band configs: alt, spread, pointSize(m), color, type
    const bands = [
      { alt: 600, spread: 600, color: [248, 248, 255] as [number, number, number], type: 'cumulus' },
      { alt: 1200, spread: 800, color: [244, 245, 254] as [number, number, number], type: 'cumulus' },
      { alt: 1800, spread: 1500, color: [200, 205, 218] as [number, number, number], type: 'anvil' },
      { alt: 3500, spread: 1200, color: [230, 234, 248] as [number, number, number], type: 'stratus' },
      { alt: 5500, spread: 1800, color: [220, 226, 244] as [number, number, number], type: 'stratus' },
      { alt: 8000, spread: 2500, color: [208, 216, 240] as [number, number, number], type: 'cirrus' },
      { alt: 10500, spread: 3000, color: [196, 206, 236] as [number, number, number], type: 'cirrus' },
    ];

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

        const maxBand = Math.ceil((0.3 + hVal * 0.7) * bands.length);

        for (let bi = 0; bi < Math.min(maxBand, bands.length); bi++) {
          const cfg = bands[bi];
          if (cfg.type === 'anvil' && stormVal < 0.2) continue;

          let eff = cloudDensity;
          if (cfg.type === 'anvil') eff *= stormVal * 1.5;
          if (eff < 0.04) continue;

          const densityMul = cfg.type === 'cirrus' ? 2 : 4;
          const numPts = Math.max(1, Math.ceil(eff * densityMul));

          for (let p = 0; p < numPts; p++) {
            const jLon = (Math.random() - 0.5) * gridStep * 1.3;
            const jLat = (Math.random() - 0.5) * gridStep * 1.3;
            const heightMod = cfg.type === 'anvil' ? 1.0 + hVal * 0.6 : 0.7 + hVal * 0.3;
            const alt = cfg.alt * heightMod + (Math.random() - 0.5) * cfg.spread * heightMod;
            const angle = Math.random() * Math.PI * 2;
            const tilt = (Math.random() - 0.5) * 0.4;
            let brightness = 0.85 + eff * 0.15;
            if (cfg.type === 'anvil') brightness *= 0.7;

            points.push({
              position: [
                city.lon + dx + jLon,
                city.lat + dy + jLat,
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
              ],
              bandIdx: bi,
            });
          }
        }
      }
    }

    this.volumetricClouds = points;
    console.log(`[VolumetricClouds] ${points.length} pts for ${city.name}`);
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

        // Radius scales with coverage — MUCH bigger for visibility
        const radius = 30000 + cf * 60000;

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

  // ── Rain — vertical streaks from cloud coverage + humidity ──────────

  private tickRain(): void {
    // Try radar first
    const radarCells = getCachedRadarCells();

    // Also use weather data for rain generation
    const grid = this.weather.getGrid('surface');

    // Spawn from radar
    if (radarCells.length > 0) {
      for (let i = 0; i < 120; i++) {
        const cell = radarCells[Math.floor(Math.random() * radarCells.length)];
        if (Math.random() > cell.intensity) continue;
        if (this.rainDrops.length >= 5000) break;

        const streakLen = 100 + Math.random() * 200 + cell.intensity * 200;
        this.rainDrops.push({
          lon: cell.lon + (Math.random() - 0.5) * 0.3,
          lat: cell.lat + (Math.random() - 0.5) * 0.2,
          elev: 800 + (1 - cell.intensity) * 2000,
          fallSpeed: 40 + Math.random() * 60 + cell.intensity * 30,
          streakLen,
          intensity: cell.intensity,
          age: 0,
          maxAge: 60 + Math.floor(Math.random() * 60),
        });
      }
    }

    // Also spawn from weather grid — where cloud fraction AND humidity are high
    if (grid?.fields.cloudFraction && grid?.fields.humidity && this.rainDrops.length < 5000) {
      const cf = grid.fields.cloudFraction;
      const hum = grid.fields.humidity;
      const w = grid.width, h = grid.height;

      for (let i = 0; i < 150; i++) {
        const gi = Math.floor(Math.random() * w);
        const gj = Math.floor(Math.random() * h);
        const idx = gj * w + gi;

        let coverage = cf[idx];
        if (coverage > 1) coverage /= 100;
        let humidity = hum[idx];
        if (humidity > 1) humidity /= 100;

        const rainProb = coverage * Math.max(0, (humidity - 40)) / 60;
        if (rainProb < 0.1) continue;
        if (Math.random() > rainProb * 1.5) continue;

        const lon = (gi / w) * 360 - 180 + (Math.random() - 0.5) * 1.0;
        const lat = 90 - (gj / h) * 180 + (Math.random() - 0.5) * 0.5;
        const streakLen = 80 + Math.random() * 150 + coverage * 150;

        this.rainDrops.push({
          lon, lat,
          elev: 600 + (1 - coverage) * 2200,
          fallSpeed: 30 + Math.random() * 50 + coverage * 25,
          streakLen,
          intensity: Math.min(1, rainProb),
          age: 0,
          maxAge: 60 + Math.floor(Math.random() * 60),
        });
      }
    }

    // Update drops → build streak paths
    const streaks: RainStreak[] = [];
    for (let i = this.rainDrops.length - 1; i >= 0; i--) {
      const d = this.rainDrops[i];
      d.age++;
      d.elev -= d.fallSpeed;

      if (d.elev <= 5 || d.age >= d.maxAge) {
        this.rainDrops[i] = this.rainDrops[this.rainDrops.length - 1];
        this.rainDrops.pop();
        continue;
      }
      if (Math.abs(d.lat) > 85) continue;

      const topElev = d.elev + d.streakLen;
      const botElev = d.elev;

      const ageFade = d.age < 4 ? d.age / 4 : 1.0;
      const groundFade = botElev < 100 ? botElev / 100 : 1.0;
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

    // ── Rain — PathLayer vertical streaks (NOT circles!) ──────────────
    if (this.radarVisible && this.rainData.length > 0) {
      layers.push(new PathLayer({
        id: 'rain-streaks',
        data: this.rainData,
        getPath: (d: RainStreak) => d.path,
        getColor: (d: RainStreak) => d.color,
        getWidth: 1.8,
        widthUnits: 'pixels',
        opacity: 0.9,
        pickable: false,
        capRounded: true,
      }));
    }

    // ── Volumetric 3D clouds — city focus (PointCloudLayer) ──────────
    if (this.cloudVisible && this.focusedCity && this.volumetricClouds.length > 0) {
      const bandConfigs = [
        { pointSize: 300, opacity: 0.70 },
        { pointSize: 450, opacity: 0.60 },
        { pointSize: 600, opacity: 0.75 },
        { pointSize: 500, opacity: 0.45 },
        { pointSize: 700, opacity: 0.35 },
        { pointSize: 800, opacity: 0.20 },
        { pointSize: 1000, opacity: 0.12 },
      ];

      // Group by band for separate layers
      for (let bi = 0; bi < bandConfigs.length; bi++) {
        const pts = this.volumetricClouds.filter(p => p.bandIdx === bi);
        if (pts.length === 0) continue;
        const cfg = bandConfigs[bi];

        layers.push(new PointCloudLayer({
          id: `volumetric-clouds-${bi}`,
          data: pts,
          getPosition: (d: any) => d.position,
          getNormal: (d: any) => d.normal,
          getColor: (d: any) => d.color,
          pointSize: cfg.pointSize,
          sizeUnits: 'meters',
          opacity: cfg.opacity,
          pickable: false,
          material: {
            ambient: 0.6,
            diffuse: 0.7,
            shininess: 20,
            specularColor: [200, 200, 210],
          },
        }));
      }
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
