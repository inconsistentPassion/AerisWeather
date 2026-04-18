/**
 * CloudLayer — Windy-style blue cloud overlay using 2D canvas (like WindParticleLayer).
 *
 * No WebGL custom layer — just a canvas overlay that projects cloud cells
 * onto the MapLibre globe using map.project(). Proven to work.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const GRID_RES = 4; // degrees per cell

export class CloudLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private noiseCanvas: HTMLCanvasElement;
  private noiseCtx: CanvasRenderingContext2D;
  private time = 0;

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    // Create overlay canvas
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '1',
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    // Pre-generate noise texture for cloud detail
    this.noiseCanvas = document.createElement('canvas');
    this.noiseCanvas.width = 256;
    this.noiseCanvas.height = 256;
    this.noiseCtx = this.noiseCanvas.getContext('2d')!;
    this.generateNoise();

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    map.on('move', () => this.clear());
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

  /** Generate a tileable noise texture for cloud detail */
  private generateNoise(): void {
    const w = this.noiseCanvas.width;
    const h = this.noiseCanvas.height;
    const img = this.noiseCtx.createImageData(w, h);
    const d = img.data;

    // Simple value noise with multiple octaves
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const nx = x / w;
        const ny = y / h;

        // 4 octaves of smooth noise
        let val = 0;
        val += smoothNoise(nx * 4, ny * 4) * 0.5;
        val += smoothNoise(nx * 8, ny * 8) * 0.25;
        val += smoothNoise(nx * 16, ny * 16) * 0.125;
        val += smoothNoise(nx * 32, ny * 32) * 0.0625;

        const v = Math.floor(Math.max(0, Math.min(1, val)) * 255);
        d[idx] = v;
        d[idx + 1] = v;
        d[idx + 2] = v;
        d[idx + 3] = 255;
      }
    }
    this.noiseCtx.putImageData(img, 0, 0);
  }

  /** Check if a globe point faces the camera (correct 3D dot product) */
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

  private frame(): void {
    if (this.canvas.style.display === 'none') return;
    if (!this.weather.isLayerActive('clouds')) { this.clear(); return; }

    const grid = this.weather.getGrid('surface');
    if (!grid) return;

    this.time += 0.016;

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    this.ctx.clearRect(0, 0, cw, ch);

    const { width, height, fields } = grid;
    const cloudFrac = fields.cloudFraction;
    if (!cloudFrac) return;

    const bounds = this.map.getBounds();
    const vpW = bounds.getWest();
    const vpE = bounds.getEast();
    const vpS = bounds.getSouth();
    const vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    // Wind offset for cloud drift
    const windLon = this.time * 0.008;
    const windLat = this.time * 0.003;

    // Draw cloud cells
    const cellW = 360 / width;
    const cellH = 180 / height;

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i;
        const coverage = cloudFrac[idx];
        if (coverage < 0.05) continue;

        // Grid cell center in lon/lat
        const lon = (i + 0.5) * cellW - 180 + windLon;
        const lat = 90 - (j + 0.5) * cellH + windLat;

        // Normalize lon
        const normLon = ((lon + 180) % 360 + 360) % 360 - 180;

        // Viewport cull
        let inView: boolean;
        if (crossesDateLine) {
          inView = (normLon >= vpW - 5) || (normLon <= vpE + 5);
        } else {
          inView = normLon >= vpW - 5 && normLon <= vpE + 5;
        }
        if (!inView) continue;
        if (lat < vpS - 5 || lat > vpN + 5) continue;
        if (!this.isFrontSide(normLon, lat)) continue;

        // Project cell corners to screen
        const hw = cellW * 0.6; // half-width in degrees
        const hh = cellH * 0.6;

        const corners: [number, number][] = [
          [normLon - hw, lat - hh],
          [normLon + hw, lat - hh],
          [normLon + hw, lat + hh],
          [normLon - hw, lat + hh],
        ];

        let allValid = true;
        const screenPts: [number, number][] = [];
        for (const [clon, clat] of corners) {
          if (!this.isFrontSide(clon, clat)) { allValid = false; break; }
          const p = this.map.project([clon, clat] as any);
          screenPts.push([p.x, p.y]);
        }
        if (!allValid || screenPts.length < 4) continue;

        // Check for degenerate projections (huge cells = back-projected)
        const dx = screenPts[1][0] - screenPts[0][0];
        const dy = screenPts[2][1] - screenPts[0][1];
        if (Math.abs(dx) > 300 || Math.abs(dy) > 300) continue;
        if (Math.abs(dx) < 1 || Math.abs(dy) < 1) continue;

        // Blue color based on coverage
        const alpha = coverage * 0.55;
        const brightness = 0.6 + coverage * 0.4; // more coverage = brighter/whiter

        // Draw cloud cell as filled polygon
        this.ctx.beginPath();
        this.ctx.moveTo(screenPts[0][0], screenPts[0][1]);
        for (let k = 1; k < screenPts.length; k++) {
          this.ctx.lineTo(screenPts[k][0], screenPts[k][1]);
        }
        this.ctx.closePath();

        // Blue gradient: low coverage = deep blue, high = light blue/white
        const r = Math.floor(lerp(30, 200, brightness));
        const g = Math.floor(lerp(60, 230, brightness));
        const b = Math.floor(lerp(140, 250, brightness));

        this.ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        this.ctx.fill();
      }
    }

    // Overlay noise texture for cloud texture/drift effect
    this.ctx.globalCompositeOperation = 'soft-light';
    const noiseX = (this.time * 3) % 256;
    const noiseY = (this.time * 2) % 256;
    const pattern = this.ctx.createPattern(this.noiseCanvas, 'repeat');
    if (pattern) {
      this.ctx.save();
      this.ctx.translate(-noiseX, -noiseY);
      this.ctx.fillStyle = pattern;
      this.ctx.globalAlpha = 0.15;
      this.ctx.fillRect(-10, -10, cw + 20, ch + 20);
      this.ctx.restore();
    }
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
  }
}

// ── helpers ──

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smoothstep
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash(ix, iy);
  const n10 = hash(ix + 1, iy);
  const n01 = hash(ix, iy + 1);
  const n11 = hash(ix + 1, iy + 1);

  const nx0 = lerp(n00, n10, sx);
  const nx1 = lerp(n01, n11, sx);

  return lerp(nx0, nx1, sy);
}
