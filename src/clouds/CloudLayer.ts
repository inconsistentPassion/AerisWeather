/**
 * CloudLayer — Smooth cloud cover from Open-Meteo data.
 * Renders cloud fraction as semi-transparent white overlay with
 * soft edges via per-cell alpha blending.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

export class CloudLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;

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

    // Sample every Nth cell for performance (don't draw all 64800 cells)
    const stepX = Math.max(1, Math.floor(width / 180));   // ~2 cells per degree
    const stepY = Math.max(1, Math.floor(height / 90));
    const cellW = 360 / width;
    const cellH = 180 / height;

    for (let j = 0; j < height; j += stepY) {
      for (let i = 0; i < width; i += stepX) {
        // Average coverage in this block
        let totalCov = 0;
        let count = 0;
        for (let dj = 0; dj < stepY && j + dj < height; dj++) {
          for (let di = 0; di < stepX && i + di < width; di++) {
            totalCov += cloudFrac[(j + dj) * width + (i + di)];
            count++;
          }
        }
        const coverage = totalCov / count;
        if (coverage < 0.02) continue;

        const lon = (i + stepX * 0.5) * cellW - 180;
        const lat = 90 - (j + stepY * 0.5) * cellH;

        // Viewport cull
        let inView: boolean;
        const margin = cellW * stepX;
        if (crossesDateLine) {
          inView = (lon >= vpW - margin) || (lon <= vpE + margin);
        } else {
          inView = lon >= vpW - margin && lon <= vpE + margin;
        }
        if (!inView || lat < vpS - margin || lat > vpN + margin) continue;
        if (!this.isFrontSide(lon, lat)) continue;

        // Project center point
        const center = this.map.project([lon, lat] as any);

        // Screen size of the cell block
        const edgeLon = lon + stepX * cellW * 0.5;
        const edgeLat = lat + stepY * cellH * 0.5;
        if (!this.isFrontSide(edgeLon, edgeLat)) continue;

        const edge = this.map.project([edgeLon, edgeLat] as any);
        const radiusX = Math.abs(edge.x - center.x);
        const radiusY = Math.abs(edge.y - center.y);

        if (radiusX < 1 || radiusY < 1) continue;
        if (radiusX > 400 || radiusY > 400) continue;

        // Draw as soft radial gradient (cloud-like, not hard rectangle)
        const alpha = coverage * 0.5;
        const grad = this.ctx.createRadialGradient(
          center.x, center.y, 0,
          center.x, center.y, Math.max(radiusX, radiusY)
        );
        grad.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(3)})`);
        grad.addColorStop(0.6, `rgba(255,255,255,${(alpha * 0.5).toFixed(3)})`);
        grad.addColorStop(1, `rgba(255,255,255,0)`);

        this.ctx.beginPath();
        this.ctx.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, Math.PI * 2);
        this.ctx.fillStyle = grad;
        this.ctx.fill();
      }
    }
  }
}
