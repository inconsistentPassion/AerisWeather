/**
 * WindParticleLayer — Windy-style animated streaks on the MapLibre globe.
 *
 * Fixes:
 *  - Antimeridian-aware viewport culling
 *  - Bilinear interpolated grid sampling (wraps at date line)
 *  - Viewport-culled: max 1000 particles projected + drawn per frame
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const TOTAL_PARTICLES = 3000;
const MAX_DRAWN = 1000;
const TRAIL_LEN = 8;
const MAX_AGE = 180;
const STEP_DEG = 0.0012;
const GLOBE_RADIUS = 6371000; // metres (MapLibre WGS84)

export class WindParticleLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;

  private lon   = new Float64Array(TOTAL_PARTICLES);
  private lat   = new Float64Array(TOTAL_PARTICLES);
  private age   = new Float64Array(TOTAL_PARTICLES);
  private spd   = new Float64Array(TOTAL_PARTICLES);
  private trailLon  = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailLat  = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailHead = new Uint16Array(TOTAL_PARTICLES);
  private visibleIdx = new Uint16Array(MAX_DRAWN);

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

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
    this.start();
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

  start(): void {
    if (this.animId !== null) return;
    const tick = () => { this.animId = requestAnimationFrame(tick); this.frame(); };
    this.animId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.animId !== null) { cancelAnimationFrame(this.animId); this.animId = null; }
  }

  setVisible(v: boolean): void {
    this.canvas.style.display = v ? '' : 'none';
    if (v) this.clear();
  }

  destroy(): void {
    this.stop();
    this.resizeObs.disconnect();
    this.canvas.remove();
  }

  /* ── bilinear wind sample (date-line safe) ──────────────────── */

  private sampleWind(
    u: Float32Array, v: Float32Array,
    lon: number, lat: number,
    gw: number, gh: number,
  ): { u: number; v: number; speed: number } {
    // normalise lon to [0, 360) for grid indexing
    let normLon = ((lon + 180) % 360 + 360) % 360;
    const x = (normLon / 360) * gw;        // continuous grid x
    const y = ((90 - lat) / 180) * gh;     // continuous grid y

    const x0 = Math.floor(x) % gw;
    const y0 = Math.max(0, Math.min(gh - 2, Math.floor(y)));
    const x1 = (x0 + 1) % gw;             // wraps at date line
    const y1 = y0 + 1;

    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);

    const idx00 = y0 * gw + x0;
    const idx01 = y0 * gw + x1;
    const idx10 = y1 * gw + x0;
    const idx11 = y1 * gw + x1;

    const uVal = bilerp(u[idx00], u[idx01], u[idx10], u[idx11], fx, fy);
    const vVal = bilerp(v[idx00], v[idx01], v[idx10], v[idx11], fx, fy);

    return { u: uVal, v: vVal, speed: Math.sqrt(uVal * uVal + vVal * vVal) };
  }

  /** Check if a globe point is on the camera-facing hemisphere */
  private isFrontSide(lon: number, lat: number): boolean {
    const t = (this.map as any).transform;
    const center = this.map.getCenter();
    if (!t || !center) return true;

    const camX = t.cameraX ?? 0;
    const camY = t.cameraY ?? 0;
    const camZ = t.cameraZ ?? (GLOBE_RADIUS * 3);

    const lr = lon * Math.PI / 180;
    const la = lat * Math.PI / 180;
    const px = GLOBE_RADIUS * Math.cos(la) * Math.cos(lr);
    const py = GLOBE_RADIUS * Math.cos(la) * Math.sin(lr);
    const pz = GLOBE_RADIUS * Math.sin(la);

    // dot product with camera direction (camera → origin)
    return px * camX + py * camY + pz * camZ > GLOBE_RADIUS * GLOBE_RADIUS * 0.15;
  }

  /* ── frame ──────────────────────────────────────────────────── */

  private frame(): void {
    if (this.canvas.style.display === 'none') return;
    if (!this.weather.isLayerActive('wind')) { this.clear(); return; }

    const wf = this.weather.getWindField('surface');
    if (!wf) return;

    const { u, v } = wf;
    const gw = 360, gh = 180;

    /* fade */
    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fillStyle = 'rgba(0,0,0,0.90)';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.globalCompositeOperation = 'source-over';

    /* viewport bounds — handle antimeridian */
    const bounds = this.map.getBounds();
    const vpW = bounds.getWest();
    const vpE = bounds.getEast();
    const vpS = bounds.getSouth();
    const vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    /* ── advect + collect visible ─────────────────────────────── */
    let visCount = 0;
    let spawned = 0;

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
      this.age[i] += 1;

      if (this.age[i] >= MAX_AGE) {
        this.spawn(i);
        spawned++;
        continue;
      }

      /* interpolated wind sample */
      const wind = this.sampleWind(u, v, this.lon[i], this.lat[i], gw, gh);
      this.spd[i] = wind.speed;

      /* advect */
      if (wind.speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.lat[i] * Math.PI / 180));
        this.lon[i] += wind.u * wind.speed * STEP_DEG / cosLat;
        this.lat[i] += wind.v * wind.speed * STEP_DEG;
        if (this.lon[i] > 180) this.lon[i] -= 360;
        if (this.lon[i] < -180) this.lon[i] += 360;
        this.lat[i] = Math.max(-85, Math.min(85, this.lat[i]));
      }

      /* push trail */
      const h = this.trailHead[i];
      const b = i * TRAIL_LEN;
      this.trailLon[b + h] = this.lon[i];
      this.trailLat[b + h] = this.lat[i];
      this.trailHead[i] = (h + 1) % TRAIL_LEN;

      /* viewport cull (antimeridian safe) */
      if (wind.speed < 0.3) continue;

      let inView: boolean;
      if (crossesDateLine) {
        // viewport spans date line: visible = lon >= west OR lon <= east
        inView = (this.lon[i] >= vpW - 2) || (this.lon[i] <= vpE + 2);
      } else {
        inView = this.lon[i] >= vpW - 2 && this.lon[i] <= vpE + 2;
      }
      if (!inView) continue;
      if (this.lat[i] < vpS - 2 || this.lat[i] > vpN + 2) continue;
      if (!this.isFrontSide(this.lon[i], this.lat[i])) continue;

      /* add to visible set (keep fastest when full) */
      if (visCount < MAX_DRAWN) {
        this.visibleIdx[visCount] = i;
        visCount++;
      } else {
        // find slowest in set and replace if this is faster
        let slowest = 0;
        let slowestSpd = Infinity;
        for (let s = 0; s < MAX_DRAWN; s++) {
          if (this.spd[this.visibleIdx[s]] < slowestSpd) {
            slowestSpd = this.spd[this.visibleIdx[s]];
            slowest = s;
          }
        }
        if (wind.speed > slowestSpd) {
          this.visibleIdx[slowest] = i;
        }
      }
    }

    /* ── draw visible particles ───────────────────────────────── */
    for (let vi = 0; vi < visCount; vi++) {
      const i = this.visibleIdx[vi];
      const s = this.spd[i];
      if (s < 0.3) continue;

      const ageAlpha = this.age[i] < 15 ? this.age[i] / 15
        : this.age[i] > MAX_AGE - 25 ? (MAX_AGE - this.age[i]) / 25 : 1;

      const color = speedColor(Math.min(s / 25, 1));
      const b = i * TRAIL_LEN;
      const h = this.trailHead[i];

      /* project trail points (skip back-facing) */
      const pts: [number, number][] = [];
      for (let t = 0; t < TRAIL_LEN; t++) {
        const slot = (h + t) % TRAIL_LEN;
        const tl = this.trailLon[b + slot];
        const tla = this.trailLat[b + slot];
        if (!this.isFrontSide(tl, tla)) {
          pts.push([-9999, -9999]); // sentinel for back-facing
        } else {
          const p = this.map.project([tl, tla] as any);
          pts.push([p.x, p.y]);
        }
      }

      /* trail segments */
      this.ctx.lineWidth = Math.min(2.5, 0.8 + s * 0.06);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      for (let t = 0; t < TRAIL_LEN - 1; t++) {
        // skip segments touching back-facing points
        if (pts[t][0] < -9000 || pts[t + 1][0] < -9000) continue;
        const segAlpha = ((t + 1) / TRAIL_LEN) * ageAlpha * 0.75;
        this.ctx.beginPath();
        this.ctx.moveTo(pts[t][0], pts[t][1]);
        this.ctx.lineTo(pts[t + 1][0], pts[t + 1][1]);
        this.ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${segAlpha.toFixed(3)})`;
        this.ctx.stroke();
      }

      /* head dot (skip if back-facing) */
      const hp = pts[TRAIL_LEN - 1];
      if (hp[0] > -9000) {
        this.ctx.beginPath();
        this.ctx.arc(hp[0], hp[1], 1.2 + s * 0.04, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(ageAlpha * 0.9).toFixed(3)})`;
        this.ctx.fill();
      }

    /* replenish */
    const budget = Math.round(TOTAL_PARTICLES * 0.02);
    for (let r = 0; r < budget - spawned && r < TOTAL_PARTICLES; r++) {
      this.spawn(Math.floor(Math.random() * TOTAL_PARTICLES));
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────── */

function bilerp(v00: number, v01: number, v10: number, v11: number, fx: number, fy: number): number {
  return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
}

function speedColor(t: number): [number, number, number] {
  if (t < 0.33) {
    const s = t / 0.33;
    return [30 + s * 50, 100 + s * 155, 220 - s * 20];
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return [80 + s * 175, 255 - s * 55, 200 - s * 180];
  }
  const s = (t - 0.66) / 0.34;
  return [255, 200 - s * 180, 20 - s * 20];
}
