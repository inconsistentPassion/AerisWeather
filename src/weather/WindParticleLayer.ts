/**
 * WindParticleLayer — Animated wind particles over MapLibre globe.
 *
 * Canvas-based particle system that reads wind field data each frame,
 * advects particles along u/v vectors using MapLibre project/unproject
 * for zoom-correct movement, and renders speed-colored dots with age fade.
 */

import type maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const NUM_PARTICLES = 5000;
const SPAWN_RATE = 60;
const MAX_AGE = 120;       // frames
const PX_PER_MS = 0.25;    // screen pixels per m/s of wind per frame
                            // 10 m/s → 2.5 px/frame → ~150 px/s @ 60fps

export class WindParticleLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private particles: Float64Array; // [lon, lat, age, speed] × NUM_PARTICLES
  private animId: number | null = null;
  private visible = true;
  private resizeObserver: ResizeObserver;

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.zIndex = '1';
    map.getContainer().appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.particles = new Float64Array(NUM_PARTICLES * 4);
    this.resize();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(map.getContainer());

    map.on('move', () => this.clearCanvas());

    this.spawnAllParticles();
    this.start();
  }

  /* ── sizing ─────────────────────────────────────────────────── */

  private resize(): void {
    const rect = this.map.getContainer().getBoundingClientRect();
    this.canvas.width = rect.width * devicePixelRatio;
    this.canvas.height = rect.height * devicePixelRatio;
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  private clearCanvas(): void {
    const w = this.canvas.width / devicePixelRatio;
    const h = this.canvas.height / devicePixelRatio;
    this.ctx.clearRect(0, 0, w, h);
  }

  /* ── spawn ──────────────────────────────────────────────────── */

  private spawnAllParticles(): void {
    for (let i = 0; i < NUM_PARTICLES; i++) this.spawnParticle(i);
  }

  private spawnParticle(i: number): void {
    const idx = i * 4;
    this.particles[idx]     = (Math.random() - 0.5) * 360;
    this.particles[idx + 1] = (Math.random() - 0.5) * 180;
    this.particles[idx + 2] = Math.random() * MAX_AGE * 0.3;
    this.particles[idx + 3] = 0;
  }

  /* ── lifecycle ──────────────────────────────────────────────── */

  start(): void {
    if (this.animId !== null) return;
    const tick = () => {
      this.animId = requestAnimationFrame(tick);
      this.frame();
    };
    this.animId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.animId !== null) { cancelAnimationFrame(this.animId); this.animId = null; }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.style.display = v ? '' : 'none';
    if (v) this.clearCanvas();
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }

  /* ── per-frame ──────────────────────────────────────────────── */

  private frame(): void {
    if (!this.visible) return;
    if (!this.weather.isLayerActive('wind')) { this.clearCanvas(); return; }

    const windField = this.weather.getWindField('surface');
    if (!windField) return;

    const { u, v } = windField;
    const gridW = 360;
    const gridH = 180;

    const cw = this.canvas.width / devicePixelRatio;
    const ch = this.canvas.height / devicePixelRatio;

    /* fade previous frame (creates trail effect) */
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
    this.ctx.fillRect(0, 0, cw, ch);
    this.ctx.globalCompositeOperation = 'source-over';

    let alive = 0;

    for (let i = 0; i < NUM_PARTICLES; i++) {
      const idx = i * 4;
      let lon = this.particles[idx];
      let lat = this.particles[idx + 1];
      let age = this.particles[idx + 2];

      age += 1;
      if (age >= MAX_AGE) { this.spawnParticle(i); continue; }

      /* ── sample wind grid (nearest-neighbour) ──────────────── */
      const gi = Math.min(gridW - 1, Math.max(0, Math.floor(((lon + 180) / 360) * gridW)));
      const gj = Math.min(gridH - 1, Math.max(0, Math.floor(((90 - lat) / 180) * gridH)));
      const gIdx = gj * gridW + gi;

      const windU = u[gIdx] || 0;
      const windV = v[gIdx] || 0;
      const speed = Math.sqrt(windU * windU + windV * windV);
      this.particles[idx + 3] = speed;

      if (speed < 0.3) {
        this.particles[idx + 2] = age;
        continue;
      }

      /* ── advect via screen-space projection ────────────────── */
      // 1. Project current lon/lat → screen pixels
      const pt = this.map.project([lon, lat] as any);

      // 2. Offset in pixels: u → rightward, v → downward on screen
      //    (screen-y increases downward; v positive = north = up = -screen-y)
      const px = pt.x + windU * PX_PER_MS;
      const py = pt.y - windV * PX_PER_MS;

      // 3. Unproject back to lon/lat
      const next = this.map.unproject([px, py] as any);
      lon = next.lng;
      lat = next.lat;

      /* wrap / clamp */
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      lat = Math.max(-85, Math.min(85, lat));

      this.particles[idx]     = lon;
      this.particles[idx + 1] = lat;
      this.particles[idx + 2] = age;

      /* ── screen position for rendering ─────────────────────── */
      // pt is already projected from step 1; re-project with new coords
      const drawPt = this.map.project([lon, lat] as any);
      const drawPx = drawPt.x * devicePixelRatio;
      const drawPy = drawPt.y * devicePixelRatio;

      if (drawPx < -20 || drawPx > this.canvas.width + 20 ||
          drawPy < -20 || drawPy > this.canvas.height + 20) continue;

      /* ── draw ──────────────────────────────────────────────── */
      const color = speedColor(Math.min(speed / 25, 1));

      const ageAlpha = age < 15
        ? age / 15
        : age > MAX_AGE - 20
          ? (MAX_AGE - age) / 20
          : 1;

      // dot
      this.ctx.beginPath();
      this.ctx.arc(drawPx, drawPy, Math.min(2.0, 1.0 + speed * 0.05), 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(ageAlpha * 0.8).toFixed(3)})`;
      this.ctx.fill();

      // glow on fast wind
      if (speed > 8) {
        const glowAlpha = Math.min(1, (speed - 8) / 15) * ageAlpha * 0.25;
        this.ctx.beginPath();
        this.ctx.arc(drawPx, drawPy, 4 + speed * 0.12, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${glowAlpha.toFixed(3)})`;
        this.ctx.fill();
      }

      alive++;
    }

    /* replenish to maintain density */
    const deficit = SPAWN_RATE - alive;
    for (let r = 0; r < deficit && r < NUM_PARTICLES; r++) {
      this.spawnParticle(Math.floor(Math.random() * NUM_PARTICLES));
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────── */

function speedColor(t: number): [number, number, number] {
  let r: number, g: number, b: number;
  if (t < 0.33) {
    const s = t / 0.33;
    r = 30 + s * 50;  g = 100 + s * 155;  b = 220 - s * 20;
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    r = 80 + s * 175;  g = 255 - s * 55;  b = 200 - s * 180;
  } else {
    const s = (t - 0.66) / 0.34;
    r = 255;  g = 200 - s * 180;  b = 20 - s * 20;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}
