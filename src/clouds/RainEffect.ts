/**
 * RainEffect — Radar-driven rain overlay on the MapLibre globe.
 *
 * Samples the MapLibre canvas directly at rain drop positions to detect
 * radar precipitation. This avoids tile compositing/projection issues
 * entirely — the radar layer already renders correctly on the globe.
 *
 * Rain falls toward the globe's visible disc center in screen space.
 */

import maplibregl from 'maplibre-gl';

const TOTAL_DROPS = 12000;
const MAX_DRAWN = 6000;
const SAMPLE_INTERVAL = 500; // ms between radar samples (expensive)

const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [80, 130, 200, 0.22],
  [120, 170, 230, 0.32],
  [160, 210, 250, 0.42],
  [200, 230, 255, 0.52],
  [240, 248, 255, 0.62],
];

interface Drop {
  lon: number;
  lat: number;
  fall: number;
  speed: number;
  length: number;
  intensity: number; // cached radar intensity
  intensityAge: number; // frames since last sample
}

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private drops: Drop[] = [];
  private visible = false;
  private lastSampleTime = 0;

  // Offscreen canvas for sampling MapLibre's rendered output
  private sampleCanvas: HTMLCanvasElement;
  private sampleCtx: CanvasRenderingContext2D;
  private sampleDirty = true;

  constructor(map: maplibregl.Map) {
    this.map = map;

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '2',
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    // Offscreen canvas for sampling the map's rendered pixels
    this.sampleCanvas = document.createElement('canvas');
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true })!;

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    // Mark sample dirty on every map render
    map.on('render', () => { this.sampleDirty = true; });

    for (let i = 0; i < TOTAL_DROPS; i++) {
      this.drops.push(this.spawn());
    }
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);

    // Match sample canvas to map canvas pixel dimensions
    const mapCanvas = this.map.getCanvas();
    this.sampleCanvas.width = mapCanvas.width;
    this.sampleCanvas.height = mapCanvas.height;
    this.sampleDirty = true;
  }

  private spawn(): Drop {
    return {
      lon: (Math.random() - 0.5) * 360,
      lat: (Math.random() - 0.5) * 150,
      fall: Math.random(),
      speed: 0.012 + Math.random() * 0.018,
      length: 0.5 + Math.random() * 0.8,
      intensity: 0,
      intensityAge: 999,
    };
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

  /**
   * Sample radar intensity from the MapLibre canvas at a screen position.
   * Draws the MapLibre WebGL canvas to an offscreen 2D canvas, then reads pixels.
   */
  private sampleCanvasAt(screenX: number, screenY: number): number {
    const mapCanvas = this.map.getCanvas();
    const mapW = mapCanvas.clientWidth;
    const mapH = mapCanvas.clientHeight;

    // Map CSS screen coords → map canvas pixel coords
    const px = Math.floor(screenX / mapW * mapCanvas.width);
    const py = Math.floor(screenY / mapH * mapCanvas.height);

    if (px < 0 || px >= mapCanvas.width || py < 0 || py >= mapCanvas.height) return 0;

    // Snapshot the MapLibre canvas (only once per frame)
    if (this.sampleDirty) {
      this.sampleCtx.drawImage(mapCanvas, 0, 0);
      this.sampleDirty = false;
    }

    try {
      const pixel = this.sampleCtx.getImageData(px, py, 1, 1).data;
      // Radar tiles: colored (green/yellow/red) on dark background
      const brightness = (pixel[0] * 0.299 + pixel[1] * 0.587 + pixel[2] * 0.114) / 255;
      // Dark bg ~0.05, radar starts ~0.15+
      return Math.max(0, (brightness - 0.08) * 2.0);
    } catch {
      return 0;
    }
  }

  private frame(): void {
    if (!this.visible || this.canvas.style.display === 'none') return;

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    this.ctx.clearRect(0, 0, cw, ch);

    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch() * Math.PI / 180;
    const now = performance.now();
    const doSample = (now - this.lastSampleTime) > SAMPLE_INTERVAL;
    if (doSample) this.lastSampleTime = now;

    // Globe disc center on screen
    const screenCenterX = cw / 2;
    const screenCenterY = ch / 2;
    const zoomScale = Math.pow(2, zoom - 2.0);
    const globeRadius = Math.min(cw, ch) * 0.38 * zoomScale;
    const discCenterX = screenCenterX;
    const discCenterY = screenCenterY + Math.sin(pitch) * globeRadius * 0.5;

    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DRAWN / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) {
      binSegs.push(new Float64Array(maxSegs));
    }

    let drawn = 0;
    const sizeScale = Math.max(0.5, Math.min(2, zoom / 5));

    for (let i = 0; i < this.drops.length && drawn < MAX_DRAWN; i++) {
      const drop = this.drops[i];

      drop.fall += drop.speed;
      if (drop.fall >= 1) {
        drop.lon = (Math.random() - 0.5) * 360;
        drop.lat = (Math.random() - 0.5) * 150;
        drop.fall = 0;
        drop.speed = 0.012 + Math.random() * 0.018;
        drop.length = 0.5 + Math.random() * 0.8;
        drop.intensity = 0;
        drop.intensityAge = 999;
      }

      // Project to screen
      const pt = this.map.project([drop.lon, drop.lat] as any);
      if (!pt) continue;

      // Check inside globe disc
      const dxFromDisc = pt.x - discCenterX;
      const dyFromDisc = pt.y - discCenterY;
      const distFromDisc = Math.sqrt(dxFromDisc * dxFromDisc + dyFromDisc * dyFromDisc);
      if (distFromDisc > globeRadius) continue;

      // Sample radar from canvas (throttled)
      if (doSample || drop.intensityAge > 30) {
        drop.intensity = this.sampleCanvasAt(pt.x, pt.y);
        drop.intensityAge = 0;
      } else {
        drop.intensityAge++;
      }

      if (drop.intensity < 0.05) continue;

      // Rain direction: toward disc center
      let rdx = 0, rdy = 1;
      if (distFromDisc > 2) {
        rdx = -dxFromDisc / distFromDisc;
        rdy = -dyFromDisc / distFromDisc;
      }

      const streakLen = drop.length * sizeScale * 12;
      const headOff = drop.fall * streakLen;
      const tailOff = (drop.fall - 1) * streakLen;

      const headX = pt.x + rdx * headOff;
      const headY = pt.y + rdy * headOff;
      const tailX = pt.x + rdx * tailOff;
      const tailY = pt.y + rdy * tailOff;

      const sdx = headX - tailX, sdy = headY - tailY;
      if (sdx * sdx + sdy * sdy > 200 * 200) continue;
      if (headY < -20 || headY > ch + 20 || tailY < -20 || tailY > ch + 20) continue;
      if (headX < -20 || headX > cw + 20 || tailX < -20 || tailX > cw + 20) continue;

      const bin = Math.min(NUM_BINS - 1, Math.floor(drop.intensity * NUM_BINS));
      const segs = binSegs[bin];
      let sc = binCounts[bin];
      if (sc >= maxSegs - 4) continue;

      segs[sc++] = tailX; segs[sc++] = tailY;
      segs[sc++] = headX; segs[sc++] = headY;
      binCounts[bin] = sc;
      drawn++;
    }

    // Flush
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
      this.ctx.lineWidth = (0.5 + b * 0.35) * sizeScale;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
