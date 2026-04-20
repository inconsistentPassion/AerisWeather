/**
 * WindParticleLayer — Canvas 2D wind streaks on the MapLibre globe.
 *
 * Uses MapLibre's project() for correct globe-to-screen mapping.
 * Particles advect through the wind field and render as color-batched
 * trail segments.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const TOTAL_PARTICLES = 50000;
const TRAIL_LEN = 5;
const MAX_AGE = 100;
const BASE_SPEED = 0.004;

const NUM_BINS = 8;
const BIN_COLORS: [number, number, number, number][] = [
  [30, 100, 220, 0.45],
  [55, 180, 210, 0.50],
  [80, 240, 195, 0.55],
  [140, 255, 120, 0.55],
  [210, 230, 55, 0.55],
  [255, 180, 30, 0.60],
  [255, 100, 15, 0.65],
  [255, 30, 10, 0.70],
];

export class WindParticleLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private visible = false;

  // Particle state (SoA)
  private lon = new Float64Array(TOTAL_PARTICLES);
  private lat = new Float64Array(TOTAL_PARTICLES);
  private age = new Float64Array(TOTAL_PARTICLES);
  private spd = new Float64Array(TOTAL_PARTICLES);
  private trailLon = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailLat = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailHead = new Uint16Array(TOTAL_PARTICLES);

  // Per-bin segment buffers
  private binSegs: Float64Array[] = [];
  private binSegCount = new Int32Array(NUM_BINS);

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    for (let b = 0; b < NUM_BINS; b++) {
      this.binSegs.push(new Float64Array(40000));
    }

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '1',
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    map.on('move', () => this.clear());

    for (let i = 0; i < TOTAL_PARTICLES; i++) this.spawn(i);
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  private clear(): void {
    const d = devicePixelRatio;
    this.ctx.clearRect(0, 0, this.canvas.width / d, this.canvas.height / d);
  }

  private spawn(i: number): void {
    this.lon[i] = (Math.random() - 0.5) * 360;
    this.lat[i] = (Math.random() - 0.5) * 180;
    this.age[i] = Math.random() * MAX_AGE * 0.3;
    this.spd[i] = 0;
    this.trailHead[i] = 0;
    const b = i * TRAIL_LEN;
    for (let t = 0; t < TRAIL_LEN; t++) {
      this.trailLon[b + t] = this.lon[i];
      this.trailLat[b + t] = this.lat[i];
    }
  }

  private isFrontSide(lon: number, lat: number): boolean {
    const c = this.map.getCenter();
    const cLat = c.lat * Math.PI / 180;
    const cLon = c.lng * Math.PI / 180;
    const pLat = lat * Math.PI / 180;
    const pLon = lon * Math.PI / 180;
    return Math.sin(cLat) * Math.sin(pLat) +
           Math.cos(cLat) * Math.cos(pLat) * Math.cos(pLon - cLon) > 0.05;
  }

  private sampleWind(u: Float32Array, v: Float32Array, lon: number, lat: number) {
    const gw = 360, gh = 180;
    const nLon = ((lon + 180) % 360 + 360) % 360;
    const x = (nLon / 360) * gw, y = ((90 - lat) / 180) * gh;
    const x0 = Math.floor(x) % gw, y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
    const x1 = (x0 + 1) % gw, y1 = Math.min(gh - 1, y0 + 1);
    const fx = x - Math.floor(x), fy = y - Math.floor(y);
    const bl = (a: number, b: number, c: number, d: number) =>
      a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    const uVal = bl(u[y0*gw+x0], u[y0*gw+x1], u[y1*gw+x0], u[y1*gw+x1]);
    const vVal = bl(v[y0*gw+x0], v[y0*gw+x1], v[y1*gw+x0], v[y1*gw+x1]);
    return { u: uVal, v: vVal, speed: Math.sqrt(uVal * uVal + vVal * vVal) };
  }

  private frame(): void {
    if (!this.visible || !this.weather.isLayerActive('wind')) {
      this.clear();
      this.animId = requestAnimationFrame(() => this.frame());
      return;
    }

    const wf = this.weather.getWindField('surface');
    if (!wf) { this.animId = requestAnimationFrame(() => this.frame()); return; }

    const { u, v } = wf;

    // Fade
    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr, ch = this.canvas.height / dpr;
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fillStyle = 'rgba(0,0,0,0.94)';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.globalCompositeOperation = 'source-over';

    const bounds = this.map.getBounds();
    const vpW = bounds.getWest(), vpE = bounds.getEast();
    const vpS = bounds.getSouth(), vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    this.binSegCount.fill(0);

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
      this.age[i] += 1;
      if (this.age[i] >= MAX_AGE) { this.spawn(i); continue; }

      const wind = this.sampleWind(u, v, this.lon[i], this.lat[i]);
      this.spd[i] = wind.speed;

      if (wind.speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.lat[i] * Math.PI / 180));
        const sf = Math.sqrt(wind.speed);
        this.lon[i] += (wind.u / wind.speed) * sf * BASE_SPEED / cosLat;
        this.lat[i] += (wind.v / wind.speed) * sf * BASE_SPEED;
        if (this.lon[i] > 180) this.lon[i] -= 360;
        if (this.lon[i] < -180) this.lon[i] += 360;
        this.lat[i] = Math.max(-85, Math.min(85, this.lat[i]));
      }

      const h = this.trailHead[i];
      const tb = i * TRAIL_LEN;
      this.trailLon[tb + h] = this.lon[i];
      this.trailLat[tb + h] = this.lat[i];
      this.trailHead[i] = (h + 1) % TRAIL_LEN;

      if (wind.speed < 0.3 || this.age[i] < TRAIL_LEN) continue;

      let inView: boolean;
      if (crossesDateLine) inView = (this.lon[i] >= vpW - 2) || (this.lon[i] <= vpE + 2);
      else inView = this.lon[i] >= vpW - 2 && this.lon[i] <= vpE + 2;
      if (!inView || this.lat[i] < vpS - 2 || this.lat[i] > vpN + 2) continue;
      if (!this.isFrontSide(this.lon[i], this.lat[i])) continue;

      // Project trail to screen
      const px = new Float64Array(TRAIL_LEN);
      const py = new Float64Array(TRAIL_LEN);
      for (let t = 0; t < TRAIL_LEN; t++) {
        const slot = (h + t) % TRAIL_LEN;
        try {
          const pt = this.map.project([this.trailLon[tb + slot], this.trailLat[tb + slot]] as any);
          px[t] = pt.x; py[t] = pt.y;
        } catch { px[t] = -9999; py[t] = -9999; }
      }

      const bin = Math.min(NUM_BINS - 1, Math.floor((wind.speed / 25) * NUM_BINS));
      const segs = this.binSegs[bin];
      let sc = this.binSegCount[bin];

      for (let t = 0; t < TRAIL_LEN - 1; t++) {
        const dx = px[t + 1] - px[t], dy = py[t + 1] - py[t];
        if (dx * dx + dy * dy > 200 * 200) continue;
        if (px[t] < -999 || px[t+1] < -999) continue;
        segs[sc++] = px[t]; segs[sc++] = py[t];
        segs[sc++] = px[t + 1]; segs[sc++] = py[t + 1];
      }
      segs[sc++] = px[TRAIL_LEN - 1]; segs[sc++] = py[TRAIL_LEN - 1];
      segs[sc++] = px[TRAIL_LEN - 1]; segs[sc++] = py[TRAIL_LEN - 1];
      this.binSegCount[bin] = sc;
    }

    // Draw
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    for (let b = 0; b < NUM_BINS; b++) {
      const count = this.binSegCount[b];
      if (count === 0) continue;
      const segs = this.binSegs[b];
      const [r, g, bl, alphaBase] = BIN_COLORS[b];

      this.ctx.beginPath();
      for (let j = 0; j < count; j += 4) {
        this.ctx.moveTo(segs[j], segs[j + 1]);
        this.ctx.lineTo(segs[j + 2], segs[j + 3]);
      }
      this.ctx.lineWidth = 0.6 + b * 0.15;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${alphaBase * 0.6})`;
      this.ctx.stroke();

      // Head dots
      this.ctx.beginPath();
      for (let j = count - 4; j >= 0; j -= 4) {
        this.ctx.moveTo(segs[j], segs[j + 1]);
        this.ctx.lineTo(segs[j + 2], segs[j + 3]);
      }
      this.ctx.lineWidth = 1.2 + b * 0.25;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${alphaBase})`;
      this.ctx.stroke();
    }

    this.animId = requestAnimationFrame(() => this.frame());
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.style.display = v ? '' : 'none';
    if (v) {
      this.clear();
      if (this.animId === null) this.frame();
    } else {
      if (this.animId !== null) { cancelAnimationFrame(this.animId); this.animId = null; }
      this.clear();
    }
  }

  destroy(): void {
    if (this.animId !== null) cancelAnimationFrame(this.animId);
    this.resizeObs.disconnect();
    this.canvas.remove();
  }
}
