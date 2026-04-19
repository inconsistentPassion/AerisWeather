/**
 * RainEffect — Animated rain overlay driven by radar/weather data.
 *
 * Renders falling rain streaks where precipitation exists.
 * Density scales with precipitation intensity from weather grid.
 * Wind angle influences rain direction.
 *
 * Canvas-based, color-batched for performance (~8 draw calls).
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const TOTAL_DROPS = 20000;
const MAX_DRAWN = 10000;

// Intensity bins for color-batched rendering
const NUM_BINS = 4;
const BIN_COLORS: [number, number, number, number][] = [
  [120, 160, 220, 0.25],  // 0: light drizzle — faint blue
  [150, 190, 240, 0.35],  // 1: moderate — blue-white
  [180, 210, 255, 0.45],  // 2: heavy — bright white-blue
  [210, 230, 255, 0.55],  // 3: very heavy — bright white
];

// Rain drop state
interface Drop {
  lon: number;
  lat: number;
  fall: number;      // 0–1 progress along streak
  speed: number;     // fall speed (varies by intensity)
  length: number;    // streak length in pixels
  intensity: number; // 0–3 bin
}

export class RainEffect {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private drops: Drop[] = [];
  private visible = false;

  // Precipitation grid cache (sampled from weather data)
  private precipGrid: Float32Array | null = null;
  private precipW = 0;
  private precipH = 0;

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '2', // above wind (z1), below UI
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    // Initialize drops
    for (let i = 0; i < TOTAL_DROPS; i++) {
      this.drops.push(this.spawn());
    }

    // Listen for weather data
    this.weather.on('dataLoaded', () => this.updatePrecipGrid());
    this.weather.on('timeChange', () => this.updatePrecipGrid());
    this.weather.on('levelChange', () => this.updatePrecipGrid());
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  private spawn(): Drop {
    return {
      lon: (Math.random() - 0.5) * 360,
      lat: (Math.random() - 0.5) * 180,
      fall: Math.random(),
      speed: 0.008 + Math.random() * 0.012,
      length: 4 + Math.random() * 8,
      intensity: 0,
    };
  }

  /** Build precipitation grid from weather data */
  private updatePrecipGrid(): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    const { width, height, fields } = grid;
    this.precipW = width;
    this.precipH = height;
    this.precipGrid = new Float32Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const humidity = fields.humidity?.[i] ?? 0;
      const cloudFraction = fields.cloudFraction?.[i] ?? 0;

      // Estimate precipitation from humidity + cloud cover
      // High humidity + high cloud cover = likely rain
      const precip = Math.max(0, (humidity - 0.6) * 2.5) * cloudFraction;
      this.precipGrid[i] = Math.min(1, precip);
    }
  }

  /** Sample precipitation at a lon/lat */
  private samplePrecip(lon: number, lat: number): number {
    if (!this.precipGrid || this.precipW === 0) return 0;

    const normLon = ((lon + 180) % 360 + 360) % 360;
    const x = (normLon / 360) * this.precipW;
    const y = ((90 - lat) / 180) * this.precipH;
    const x0 = Math.floor(x) % this.precipW;
    const y0 = Math.max(0, Math.min(this.precipH - 1, Math.floor(y)));
    const x1 = (x0 + 1) % this.precipW;
    const y1 = Math.min(this.precipH - 1, y0 + 1);
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);

    const i00 = y0 * this.precipW + x0;
    const i01 = y0 * this.precipW + x1;
    const i10 = y1 * this.precipW + x0;
    const i11 = y1 * this.precipW + x1;

    return this.precipGrid[i00] * (1 - fx) * (1 - fy) +
           this.precipGrid[i01] * fx * (1 - fy) +
           this.precipGrid[i10] * (1 - fx) * fy +
           this.precipGrid[i11] * fx * fy;
  }

  /** Sample wind at a lon/lat (for rain angle) */
  private sampleWind(lon: number, lat: number): { u: number; v: number } {
    const wf = this.weather.getWindField('surface');
    if (!wf) return { u: 0, v: 0 };

    const { u, v } = wf;
    const gw = 360, gh = 180;
    const normLon = ((lon + 180) % 360 + 360) % 360;
    const x = (normLon / 360) * gw;
    const y = ((90 - lat) / 180) * gh;
    const x0 = Math.floor(x) % gw;
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
    const x1 = (x0 + 1) % gw;
    const y1 = Math.min(gh - 1, y0 + 1);
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);

    const i00 = y0 * gw + x0, i01 = y0 * gw + x1;
    const i10 = y1 * gw + x0, i11 = y1 * gw + x1;

    return {
      u: u[i00] * (1 - fx) * (1 - fy) + u[i01] * fx * (1 - fy) + u[i10] * (1 - fx) * fy + u[i11] * fx * fy,
      v: v[i00] * (1 - fx) * (1 - fy) + v[i01] * fx * (1 - fy) + v[i10] * (1 - fx) * fy + v[i11] * fx * fy,
    };
  }

  private isFrontSide(lon: number, lat: number): boolean {
    const c = this.map.getCenter();
    const cLat = c.lat * Math.PI / 180;
    const cLon = c.lng * Math.PI / 180;
    const pLat = lat * Math.PI / 180;
    const pLon = lon * Math.PI / 180;
    return Math.sin(cLat) * Math.sin(pLat) +
           Math.cos(cLat) * Math.cos(pLat) * Math.cos(pLon - cLon) > 0;
  }

  start(): void {
    if (this.animId !== null) return;
    this.visible = true;
    const tick = () => { this.animId = requestAnimationFrame(tick); this.frame(); };
    this.animId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.visible = false;
    if (this.animId !== null) { cancelAnimationFrame(this.animId); this.animId = null; }
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? '' : 'none';
    if (v) { this.clear(); this.start(); }
    else { this.stop(); this.clear(); }
  }

  destroy(): void {
    this.stop();
    this.resizeObs.disconnect();
    this.canvas.remove();
  }

  private clear(): void {
    const d = devicePixelRatio;
    this.ctx.clearRect(0, 0, this.canvas.width / d, this.canvas.height / d);
  }

  private frame(): void {
    if (!this.visible || this.canvas.style.display === 'none') return;

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;

    // Clear fully each frame (rain doesn't trail like wind)
    this.ctx.clearRect(0, 0, cw, ch);

    // Viewport
    const bounds = this.map.getBounds();
    const vpW = bounds.getWest(), vpE = bounds.getEast();
    const vpS = bounds.getSouth(), vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    // Bin segments for batched rendering
    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DRAWN / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) {
      binSegs.push(new Float64Array(maxSegs));
    }

    let drawn = 0;
    const zoom = this.map.getZoom();
    const sizeScale = Math.max(0.5, Math.min(2, zoom / 5)); // scale streaks with zoom

    for (let i = 0; i < this.drops.length && drawn < MAX_DRAWN; i++) {
      const drop = this.drops[i];

      // Advance fall
      drop.fall += drop.speed;
      if (drop.fall >= 1) {
        // Respawn
        drop.lon = (Math.random() - 0.5) * 360;
        drop.lat = (Math.random() - 0.5) * 180;
        drop.fall = 0;
        drop.speed = 0.008 + Math.random() * 0.012;
        drop.length = 4 + Math.random() * 8;
      }

      // Sample precipitation to decide if this drop is visible
      const precip = this.samplePrecip(drop.lon, drop.lat);
      if (precip < 0.05) continue; // skip dry areas

      // Intensity bin
      drop.intensity = Math.min(NUM_BINS - 1, Math.floor(precip * NUM_BINS));

      // Viewport cull
      let inView: boolean;
      if (crossesDateLine) {
        inView = (drop.lon >= vpW - 2) || (drop.lon <= vpE + 2);
      } else {
        inView = drop.lon >= vpW - 2 && drop.lon <= vpE + 2;
      }
      if (!inView || drop.lat < vpS - 2 || drop.lat > vpN + 2) continue;
      if (!this.isFrontSide(drop.lon, drop.lat)) continue;

      // Project to screen
      const pt = this.map.project([drop.lon, drop.lat] as any);

      // Wind offset — rain falls at an angle
      const wind = this.sampleWind(drop.lon, drop.lat);
      const windAngle = Math.atan2(wind.u, -wind.v); // angle from vertical
      const windStrength = Math.sqrt(wind.u * wind.u + wind.v * wind.v);
      const lean = Math.min(0.5, windStrength * 0.02); // max 30° lean

      // Streak: head at current position, tail behind in fall direction
      const len = drop.length * sizeScale;
      const tailX = pt.x + Math.sin(windAngle) * lean * len;
      const tailY = pt.y - len * (1 - drop.fall); // tail below head
      const headX = pt.x;
      const headY = pt.y + len * drop.fall; // head moves down during fall

      // Distance check (skip if segment too long = projection artifact)
      const dx = headX - tailX, dy = headY - tailY;
      if (dx * dx + dy * dy > 150 * 150) continue;

      // Add to bin
      const bin = drop.intensity;
      const segs = binSegs[bin];
      let sc = binCounts[bin];
      if (sc >= maxSegs - 4) continue;

      segs[sc++] = tailX;
      segs[sc++] = tailY;
      segs[sc++] = headX;
      segs[sc++] = headY;
      binCounts[bin] = sc;
      drawn++;
    }

    // Flush: one stroke per intensity bin
    this.ctx.lineCap = 'round';

    for (let b = 0; b < NUM_BINS; b++) {
      const count = binCounts[b];
      if (count === 0) continue;

      const segs = binSegs[b];
      const [r, g, bl, a] = BIN_COLORS[b];

      this.ctx.beginPath();
      for (let j = 0; j < count; j += 4) {
        this.ctx.moveTo(segs[j], segs[j + 1]);
        this.ctx.lineTo(segs[j + 2], segs[j + 3]);
      }
      this.ctx.lineWidth = (1 + b * 0.5) * sizeScale;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
