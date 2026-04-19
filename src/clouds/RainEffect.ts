/**
 * RainEffect — Animated rain overlay on the globe.
 *
 * Rain falls PERPENDICULAR to the globe surface (toward center),
 * driven by precipitation data. Density scales with intensity.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const TOTAL_DROPS = 30000;
const MAX_DRAWN = 15000;

// Intensity bins for color-batched rendering
const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [100, 140, 200, 0.15],  // 0: trace — barely visible
  [120, 165, 220, 0.28],  // 1: light
  [150, 195, 240, 0.38],  // 2: moderate
  [180, 215, 250, 0.48],  // 3: heavy
  [210, 235, 255, 0.58],  // 4: very heavy
];

interface Drop {
  lon: number;
  lat: number;
  fall: number;      // 0–1 progress along streak
  speed: number;     // fall speed
  length: number;    // streak length multiplier
  intensity: number; // 0–4 bin
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

  // Precipitation grid
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
      pointerEvents: 'none', zIndex: '2',
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    for (let i = 0; i < TOTAL_DROPS; i++) {
      this.drops.push(this.spawn());
    }

    this.weather.on('dataLoaded', () => this.updatePrecipGrid());
    this.weather.on('timeChange', () => this.updatePrecipGrid());
    this.weather.on('levelChange', () => this.updatePrecipGrid());

    // Try to populate immediately in case data is already loaded
    this.updatePrecipGrid();
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
      lat: (Math.random() - 0.5) * 160, // avoid extreme poles
      fall: Math.random(),
      speed: 0.01 + Math.random() * 0.015,
      length: 0.5 + Math.random() * 1.0,
      intensity: 0,
    };
  }

  /** Build precipitation grid — cloudFraction is the primary driver */
  private updatePrecipGrid(): void {
    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    const { width, height, fields } = grid;
    this.precipW = width;
    this.precipH = height;
    this.precipGrid = new Float32Array(width * height);

    for (let i = 0; i < width * height; i++) {
      const cloud = fields.cloudFraction?.[i] ?? 0;  // 0–1
      const humidity = (fields.humidity?.[i] ?? 50) / 100;  // 0–100 → 0–1

      // Precipitation = cloud cover weighted by excess humidity
      // Only thick clouds with high humidity produce rain
      const humidityFactor = Math.max(0, (humidity - 0.55) * 2.2);
      const precip = cloud * humidityFactor;
      this.precipGrid[i] = Math.min(1, precip);
    }
  }

  /** Bilinear sample precipitation */
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

    const i00 = y0 * this.precipW + x0, i01 = y0 * this.precipW + x1;
    const i10 = y1 * this.precipW + x0, i11 = y1 * this.precipW + x1;

    return this.precipGrid[i00] * (1 - fx) * (1 - fy) +
           this.precipGrid[i01] * fx * (1 - fy) +
           this.precipGrid[i10] * (1 - fx) * fy +
           this.precipGrid[i11] * fx * fy;
  }

  /** Bilinear sample wind */
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

  /**
   * Get rain direction in screen space — toward globe center.
   * "Perpendicular to surface" on a sphere = radial inward.
   * Direction = from surface point toward map center in screen space.
   */
  private getRainDirection(lon: number, lat: number): { dx: number; dy: number } | null {
    const pt = this.map.project([lon, lat] as any);
    if (!pt) return null;

    // Globe center in screen space = project the map center
    const center = this.map.getCenter();
    const centerPt = this.map.project([center.lng, center.lat] as any);
    if (!centerPt) return null;

    // Direction from surface point toward center = "down toward earth"
    const dx = centerPt.x - pt.x;
    const dy = centerPt.y - pt.y;
    const len = Math.sqrt(dx * dx + dy * dy);

    if (len < 1) return null; // looking straight at the point

    return { dx: dx / len, dy: dy / len };
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
    this.ctx.clearRect(0, 0, cw, ch);

    const bounds = this.map.getBounds();
    const vpW = bounds.getWest(), vpE = bounds.getEast();
    const vpS = bounds.getSouth(), vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    // Bin segments
    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DRAWN / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) {
      binSegs.push(new Float64Array(maxSegs));
    }

    let drawn = 0;
    const zoom = this.map.getZoom();
    const sizeScale = Math.max(0.4, Math.min(2.5, zoom / 4));

    for (let i = 0; i < this.drops.length && drawn < MAX_DRAWN; i++) {
      const drop = this.drops[i];

      // Advance fall
      drop.fall += drop.speed;
      if (drop.fall >= 1) {
        // Respawn in a random location
        drop.lon = (Math.random() - 0.5) * 360;
        drop.lat = (Math.random() - 0.5) * 160;
        drop.fall = 0;
        drop.speed = 0.01 + Math.random() * 0.015;
        drop.length = 0.5 + Math.random() * 1.0;
      }

      // Sample precipitation
      const precip = this.samplePrecip(drop.lon, drop.lat);
      if (precip < 0.02) continue;

      // Intensity bin
      drop.intensity = Math.min(NUM_BINS - 1, Math.floor(precip * NUM_BINS));

      // Viewport cull
      let inView: boolean;
      if (crossesDateLine) {
        inView = (drop.lon >= vpW - 3) || (drop.lon <= vpE + 3);
      } else {
        inView = drop.lon >= vpW - 3 && drop.lon <= vpE + 3;
      }
      if (!inView || drop.lat < vpS - 3 || drop.lat > vpN + 3) continue;
      if (!this.isFrontSide(drop.lon, drop.lat)) continue;

      // Project surface point
      const pt = this.map.project([drop.lon, drop.lat] as any);
      if (!pt) continue;

      // Get perpendicular-to-surface direction (toward globe center)
      const normal = this.getRainDirection(drop.lon, drop.lat);
      if (!normal) continue;

      // Wind lean — shift rain direction slightly downwind
      const wind = this.sampleWind(drop.lon, drop.lat);
      const windStrength = Math.sqrt(wind.u * wind.u + wind.v * wind.v);
      const windLean = Math.min(0.35, windStrength * 0.015);

      // Pure perpendicular direction + wind lean
      // normal points toward center (rain direction)
      // Wind shifts it sideways
      let dirX = normal.dx;
      let dirY = normal.dy;

      if (windStrength > 0.5) {
        // Wind direction in screen space (approximate: east=right, south=down)
        const windAngle = Math.atan2(wind.v, wind.u);
        dirX += Math.cos(windAngle) * windLean;
        dirY += Math.sin(windAngle) * windLean;
        // Re-normalize
        const len = Math.sqrt(dirX * dirX + dirY * dirY);
        if (len > 0.01) { dirX /= len; dirY /= len; }
      }

      // Streak: tail (behind) → head (current fall position)
      const streakLen = drop.length * sizeScale * 12;
      const headOffset = drop.fall * streakLen;
      const tailOffset = (drop.fall - 1) * streakLen;

      const headX = pt.x + dirX * headOffset;
      const headY = pt.y + dirY * headOffset;
      const tailX = pt.x + dirX * tailOffset;
      const tailY = pt.y + dirY * tailOffset;

      // Skip degenerate/out-of-bounds segments
      const dx = headX - tailX, dy = headY - tailY;
      if (dx * dx + dy * dy > 200 * 200) continue;
      if (headX < -50 || headX > cw + 50 || headY < -50 || headY > ch + 50) continue;

      // Add to bin
      const bin = drop.intensity;
      const segs = binSegs[bin];
      let sc = binCounts[bin];
      if (sc >= maxSegs - 4) continue;

      segs[sc++] = tailX; segs[sc++] = tailY;
      segs[sc++] = headX; segs[sc++] = headY;
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
      this.ctx.lineWidth = (0.8 + b * 0.4) * sizeScale;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
