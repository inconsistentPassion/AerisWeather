/**
 * WindParticleLayer — Animated wind particles over MapLibre globe.
 *
 * Canvas-based particle system that reads wind field data each frame,
 * advects particles along u/v vectors, and renders speed-colored trails
 * with age-based fade. Tied to the 'wind' layer toggle.
 */

import type maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const NUM_PARTICLES = 5000;
const TRAIL_LENGTH = 10;
const SPAWN_RATE = 60; // particles respawned per frame
const MAX_AGE = 120;   // frames

export class WindParticleLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private particles: Float64Array; // [x, y, age, speed] × NUM_PARTICLES
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

    // Keep canvas in sync with map size
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(map.getContainer());

    // React to map moves (pan/zoom) so trails don't smear
    map.on('move', () => this.clearCanvas());

    this.spawnAllParticles();
    this.start();
  }

  /** Resize canvas to match container device pixels */
  private resize(): void {
    const rect = this.map.getContainer().getBoundingClientRect();
    this.canvas.width = rect.width * devicePixelRatio;
    this.canvas.height = rect.height * devicePixelRatio;
    this.ctx.scale(devicePixelRatio, devicePixelRatio);
  }

  private clearCanvas(): void {
    const w = this.canvas.width / devicePixelRatio;
    const h = this.canvas.height / devicePixelRatio;
    this.ctx.clearRect(0, 0, w, h);
  }

  /** Seed all particles at random lon/lat */
  private spawnAllParticles(): void {
    for (let i = 0; i < NUM_PARTICLES; i++) this.spawnParticle(i);
  }

  /** Seed one particle at a random map position */
  private spawnParticle(i: number): void {
    const idx = i * 4;
    this.particles[idx]     = (Math.random() - 0.5) * 360;  // lon
    this.particles[idx + 1] = (Math.random() - 0.5) * 180;  // lat
    this.particles[idx + 2] = Math.random() * MAX_AGE * 0.3; // age (stagger)
    this.particles[idx + 3] = 0;                              // speed
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
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
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
    if (!this.weather.isLayerActive('wind')) {
      this.clearCanvas();
      return;
    }

    const windField = this.weather.getWindField('surface');
    if (!windField) return;

    const { u, v } = windField;
    const gridW = 360;
    const gridH = 180;
    const w = this.canvas.width / devicePixelRatio;
    const h = this.canvas.height / devicePixelRatio;

    /* fade previous frame */
    this.ctx.globalCompositeOperation = 'destination-in';
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.93)';
    this.ctx.fillRect(0, 0, w, h);
    this.ctx.globalCompositeOperation = 'source-over';

    let respawned = 0;

    for (let i = 0; i < NUM_PARTICLES; i++) {
      const idx = i * 4;
      let lon  = this.particles[idx];
      let lat  = this.particles[idx + 1];
      let age  = this.particles[idx + 2];

      age += 1;

      /* respawn old or newly off-screen */
      if (age >= MAX_AGE) {
        this.spawnParticle(i);
        continue;
      }

      /* sample wind grid (nearest-neighbour) */
      const gi = Math.min(gridW - 1, Math.max(0,
        Math.floor(((lon + 180) / 360) * gridW)));
      const gj = Math.min(gridH - 1, Math.max(0,
        Math.floor(((90 - lat) / 180) * gridH)));
      const gIdx = gj * gridW + gi;

      const windU = u[gIdx] || 0;
      const windV = v[gIdx] || 0;
      const speed = Math.sqrt(windU * windU + windV * windV);
      this.particles[idx + 3] = speed;

      /* advect (m/s → deg/s approximation) */
      const advectSpeed = speed * 0.04;
      lon += windU * advectSpeed / Math.max(0.3, Math.cos(lat * Math.PI / 180));
      lat += windV * advectSpeed * 0.6;

      /* wrap longitude, clamp latitude */
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;
      lat = Math.max(-85, Math.min(85, lat));

      this.particles[idx]     = lon;
      this.particles[idx + 1] = lat;
      this.particles[idx + 2] = age;

      /* project to screen */
      const pt = this.map.project([lon, lat] as any);
      const px = pt.x * devicePixelRatio;
      const py = pt.y * devicePixelRatio;

      /* skip off-screen */
      if (px < -20 || px > this.canvas.width + 20 ||
          py < -20 || py > this.canvas.height + 20) continue;

      /* skip too-calm */
      if (speed < 0.3) continue;

      /* colour by speed */
      const color = speedColor(Math.min(speed / 25, 1));

      /* age-based alpha */
      const ageAlpha = age < 15
        ? age / 15
        : age > MAX_AGE - 20
          ? (MAX_AGE - age) / 20
          : 1;

      /* draw particle */
      this.ctx.beginPath();
      this.ctx.arc(px, py, Math.min(2.0, 1.0 + speed * 0.06), 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(ageAlpha * 0.75).toFixed(3)})`;
      this.ctx.fill();

      /* glow for fast wind */
      if (speed > 8) {
        const glowAlpha = Math.min(1, (speed - 8) / 15) * ageAlpha * 0.3;
        this.ctx.beginPath();
        this.ctx.arc(px, py, 4 + speed * 0.15, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${glowAlpha.toFixed(3)})`;
        this.ctx.fill();
      }

      respawned++;
    }

    /* respawn some dead particles to keep density steady */
    for (let r = 0; r < SPAWN_RATE - respawned && r < NUM_PARTICLES; r++) {
      const i = Math.floor(Math.random() * NUM_PARTICLES);
      this.spawnParticle(i);
    }
  }
}

/* ── helpers ──────────────────────────────────────────────────── */

/** Map normalised speed [0…1] → [r, g, b]. Blue → cyan → yellow → red. */
function speedColor(t: number): [number, number, number] {
  let r: number, g: number, b: number;

  if (t < 0.33) {
    const s = t / 0.33;
    r = 30 + s * 50;
    g = 100 + s * 155;
    b = 220 - s * 20;
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    r = 80 + s * 175;
    g = 255 - s * 55;
    b = 200 - s * 180;
  } else {
    const s = (t - 0.66) / 0.34;
    r = 255;
    g = 200 - s * 180;
    b = 20 - s * 20;
  }

  return [Math.round(r), Math.round(g), Math.round(b)];
}
