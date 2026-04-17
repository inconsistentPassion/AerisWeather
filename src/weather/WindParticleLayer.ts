/**
 * WindParticleLayer — Windy-style animated streaks on the MapLibre globe.
 *
 * Performance-optimised:
 *  - Viewport culling via map.getBounds()
 *  - Hard cap: max 1000 particles projected + drawn per frame
 *  - Priority: fastest visible particles rendered first
 *  - No project() calls for off-screen or calm particles
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const TOTAL_PARTICLES = 3000;  // kept in reserve
const MAX_DRAWN = 1000;        // hard cap on rendered per frame
const TRAIL_LEN = 8;
const MAX_AGE = 180;
const STEP_DEG = 0.0012;       // degrees per m/s per frame

export class WindParticleLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;

  // particle state
  private lon   = new Float64Array(TOTAL_PARTICLES);
  private lat   = new Float64Array(TOTAL_PARTICLES);
  private age   = new Float64Array(TOTAL_PARTICLES);
  private spd   = new Float64Array(TOTAL_PARTICLES);
  private trailLon  = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailLat  = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailHead = new Uint16Array(TOTAL_PARTICLES);

  // reusable index list for culling
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

  /* ── sizing ─────────────────────────────────────────────────── */

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const dpr = devicePixelRatio;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width / devicePixelRatio, this.canvas.height / devicePixelRatio);
  }

  /* ── spawn ──────────────────────────────────────────────────── */

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

  /* ── lifecycle ──────────────────────────────────────────────── */

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

  /* ── frame ──────────────────────────────────────────────────── */

  private frame(): void {
    if (this.canvas.style.display === 'none') return;
    if (!this.weather.isLayerActive('wind')) { this.clear(); return; }

    const wf = this.weather.getWindField('surface');
    if (!wf) return;

    const { u, v } = wf;
    const gw = 360, gh = 180;

    /* fade */
    const cw = this.canvas.width / devicePixelRatio;
    const ch = this.canvas.height / devicePixelRatio;
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fillStyle = 'rgba(0,0,0,0.90)';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.globalCompositeOperation = 'source-over';

    /* viewport bounds for culling */
    const bounds = this.map.getBounds();
    const vpW = bounds.getWest();
    const vpE = bounds.getEast();
    const vpS = bounds.getSouth();
    const vpN = bounds.getNorth();

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

      /* grid sample */
      const gi = Math.min(gw - 1, Math.max(0, Math.floor(((this.lon[i] + 180) / 360) * gw)));
      const gj = Math.min(gh - 1, Math.max(0, Math.floor(((90 - this.lat[i]) / 180) * gh)));
      const idx = gj * gw + gi;
      const wu = u[idx] || 0, wv = v[idx] || 0;
      const spd = Math.sqrt(wu * wu + wv * wv);
      this.spd[i] = spd;

      /* advect (cheap — no projection) */
      if (spd >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.lat[i] * Math.PI / 180));
        this.lon[i] += wu * spd * STEP_DEG / cosLat;
        this.lat[i] += wv * spd * STEP_DEG;
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

      /* viewport cull */
      if (spd < 0.3) continue;
      if (this.lon[i] < vpW - 2 || this.lon[i] > vpE + 2) continue;
      if (this.lat[i] < vpS - 2 || this.lat[i] > vpN + 2) continue;

      if (visCount < MAX_DRAWN) {
        this.visibleIdx[visCount] = i;
        visCount++;
      } else {
        /* replace slowest among selected (simple: random) */
        const ri = Math.floor(Math.random() * MAX_DRAWN);
        if (spd > this.spd[this.visibleIdx[ri]]) {
          this.visibleIdx[ri] = i;
        }
      }
    }

    /* ── draw only visible particles ──────────────────────────── */
    const dpr = devicePixelRatio;

    for (let v = 0; v < visCount; v++) {
      const i = this.visibleIdx[v];
      const s = this.spd[i];
      if (s < 0.3) continue;

      const ageAlpha = this.age[i] < 15 ? this.age[i] / 15
        : this.age[i] > MAX_AGE - 25 ? (MAX_AGE - this.age[i]) / 25 : 1;

      const color = speedColor(Math.min(s / 25, 1));
      const b = i * TRAIL_LEN;
      const h = this.trailHead[i];

      /* project trail points */
      const pts: [number, number][] = [];
      for (let t = 0; t < TRAIL_LEN; t++) {
        const slot = (h + t) % TRAIL_LEN;
        const p = this.map.project([this.trailLon[b + slot], this.trailLat[b + slot]] as any);
        pts.push([p.x, p.y]);
      }

      /* draw trail segments */
      this.ctx.lineWidth = Math.min(2.5, 0.8 + s * 0.06);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';

      for (let t = 0; t < TRAIL_LEN - 1; t++) {
        const segAlpha = ((t + 1) / TRAIL_LEN) * ageAlpha * 0.75;
        this.ctx.beginPath();
        this.ctx.moveTo(pts[t][0], pts[t][1]);
        this.ctx.lineTo(pts[t + 1][0], pts[t + 1][1]);
        this.ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${segAlpha.toFixed(3)})`;
        this.ctx.stroke();
      }

      /* head dot */
      const hp = pts[TRAIL_LEN - 1];
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
