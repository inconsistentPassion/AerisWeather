/**
 * WindParticleLayer — Windy-style animated streaks on the MapLibre globe.
 *
 * Canvas overlay with trail-based particles:
 *  - Stretches when fast, shrinks when slow (Windy-style)
 *  - ~1000 particles visible on screen at any zoom level
 *  - Speed-colored with age fade
 *  - Clears on map movement to avoid smearing
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const BASE_PARTICLES = 1200;  // particles at zoom 2 (globe view)
const TRAIL_LEN = 8;          // points in each particle's trail
const MAX_AGE = 180;           // frames before respawn
const STEP_PER_MS = 0.0012;   // degrees per m/s per frame (slower than before)

export class WindParticleLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;

  // flat arrays, sized dynamically
  private maxParticles = BASE_PARTICLES;
  private count = 0;
  private lon!: Float64Array;
  private lat!: Float64Array;
  private age!: Float64Array;
  private speed!: Float64Array;
  // trail ring buffer per particle: trailLon[i*TRAIL_LEN + slot]
  private trailLon!: Float64Array;
  private trailLat!: Float64Array;
  private trailHead!: Uint16Array; // write index per particle

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    /* canvas overlay */
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '1',
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.resize();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());

    map.on('move', () => this.clear());
    map.on('zoom', () => this.recount());

    this.recount();
    this.start();
  }

  /* ── sizing / density ───────────────────────────────────────── */

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    this.canvas.width = r.width * devicePixelRatio;
    this.canvas.height = r.height * devicePixelRatio;
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Scale particle count so ~1000 are visible at any zoom */
  private recount(): void {
    const z = this.map.getZoom();
    // screen area ∝ 4^z; base at z=2
    const scale = Math.pow(4, Math.max(0, z - 2));
    const target = Math.round(BASE_PARTICLES * scale);
    this.maxParticles = Math.min(target, 20000); // cap for perf
    this.ensureArrays();
    // spawn extras if we grew
    while (this.count < this.maxParticles) {
      this.spawn(this.count);
      this.count++;
    }
  }

  private ensureArrays(): void {
    const n = this.maxParticles;
    if (this.lon && this.lon.length >= n) return;
    this.lon      = new Float64Array(n);
    this.lat      = new Float64Array(n);
    this.age      = new Float64Array(n);
    this.speed    = new Float64Array(n);
    this.trailLon = new Float64Array(n * TRAIL_LEN);
    this.trailLat = new Float64Array(n * TRAIL_LEN);
    this.trailHead = new Uint16Array(n);
    // seed existing
    for (let i = 0; i < this.count; i++) this.spawn(i);
  }

  private spawn(i: number): void {
    this.lon[i]   = (Math.random() - 0.5) * 360;
    this.lat[i]   = (Math.random() - 0.5) * 180;
    this.age[i]   = Math.random() * MAX_AGE * 0.3;
    this.speed[i] = 0;
    this.trailHead[i] = 0;
    const base = i * TRAIL_LEN;
    for (let t = 0; t < TRAIL_LEN; t++) {
      this.trailLon[base + t] = this.lon[i];
      this.trailLat[base + t] = this.lat[i];
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
    const gridW = 360, gridH = 180;

    /* fade previous frame → trail effect */
    const cw = this.canvas.width / devicePixelRatio;
    const ch = this.canvas.height / devicePixelRatio;
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fillStyle = 'rgba(0,0,0,0.90)';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.globalCompositeOperation = 'source-over';

    let spawned = 0;
    const n = this.count;

    for (let i = 0; i < n; i++) {
      this.age[i] += 1;

      if (this.age[i] >= MAX_AGE) {
        this.spawn(i);
        spawned++;
        continue;
      }

      /* grid sample */
      const gi = Math.min(gridW - 1, Math.max(0, Math.floor(((this.lon[i] + 180) / 360) * gridW)));
      const gj = Math.min(gridH - 1, Math.max(0, Math.floor(((90 - this.lat[i]) / 180) * gridH)));
      const idx = gj * gridW + gi;
      const wu = u[idx] || 0, wv = v[idx] || 0;
      const spd = Math.sqrt(wu * wu + wv * wv);
      this.speed[i] = spd;

      if (spd < 0.3) continue;

      /* advect — project to screen, offset, unproject */
      const pt = this.map.project([this.lon[i], this.lat[i]] as any);
      const step = spd * STEP_PER_MS;
      // u = eastward, v = northward (screen y inverted)
      const nx = pt.x + wu / spd * step * 60;  // 60 ≈ pixels per degree at z~2
      const ny = pt.y - wv / spd * step * 60;
      const np = this.map.unproject([nx, ny] as any);

      this.lon[i] = ((np.lng + 180 + 360) % 360) - 180;
      this.lat[i] = Math.max(-85, Math.min(85, np.lat));

      /* push trail */
      const head = this.trailHead[i];
      const base = i * TRAIL_LEN;
      this.trailLon[base + head] = this.lon[i];
      this.trailLat[base + head] = this.lat[i];
      this.trailHead[i] = (head + 1) % TRAIL_LEN;
    }

    /* ── draw trails ──────────────────────────────────────────── */
    for (let i = 0; i < n; i++) {
      if (this.speed[i] < 0.3) continue;

      const ageAlpha = this.age[i] < 15 ? this.age[i] / 15
        : this.age[i] > MAX_AGE - 25 ? (MAX_AGE - this.age[i]) / 25 : 1;

      const color = speedColor(Math.min(this.speed[i] / 25, 1));
      const base = i * TRAIL_LEN;
      const head = this.trailHead[i];

      /* collect projected points in trail order (oldest → newest) */
      const pts: Array<[number, number]> = [];
      for (let t = 0; t < TRAIL_LEN; t++) {
        const slot = (head + t) % TRAIL_LEN;
        const lon = this.trailLon[base + slot];
        const lat = this.trailLat[base + slot];
        const p = this.map.project([lon, lat] as any);
        pts.push([p.x, p.y]);
      }

      /* draw connected line with gradient fade */
      this.ctx.lineWidth = Math.min(2.5, 0.8 + this.speed[i] * 0.06);
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
      const headPt = pts[TRAIL_LEN - 1];
      this.ctx.beginPath();
      this.ctx.arc(headPt[0], headPt[1], 1.2 + this.speed[i] * 0.04, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(ageAlpha * 0.9).toFixed(3)})`;
      this.ctx.fill();
    }

    /* replenish */
    const budget = Math.round(n * 0.03);
    for (let r = 0; r < budget - spawned; r++) {
      const i = Math.floor(Math.random() * n);
      this.spawn(i);
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
