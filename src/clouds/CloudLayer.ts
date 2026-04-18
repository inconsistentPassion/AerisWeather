/**
 * CloudLayer — Cloud cover overlay from Open-Meteo weather data.
 * Renders cloud fraction as semi-transparent white cells on the globe.
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

  /** Check if a globe point faces the camera */
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

    const cellW = 360 / width;
    const cellH = 180 / height;

    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const idx = j * width + i;
        const coverage = cloudFrac[idx];
        if (coverage < 0.05) continue;

        const lon = (i + 0.5) * cellW - 180;
        const lat = 90 - (j + 0.5) * cellH;

        // Viewport cull
        let inView: boolean;
        if (crossesDateLine) {
          inView = (lon >= vpW - 5) || (lon <= vpE + 5);
        } else {
          inView = lon >= vpW - 5 && lon <= vpE + 5;
        }
        if (!inView || lat < vpS - 5 || lat > vpN + 5) continue;
        if (!this.isFrontSide(lon, lat)) continue;

        // Project cell corners
        const hw = cellW * 0.6;
        const hh = cellH * 0.6;
        const corners: [number, number][] = [
          [lon - hw, lat - hh], [lon + hw, lat - hh],
          [lon + hw, lat + hh], [lon - hw, lat + hh],
        ];

        let allValid = true;
        const screenPts: [number, number][] = [];
        for (const [clon, clat] of corners) {
          if (!this.isFrontSide(clon, clat)) { allValid = false; break; }
          const p = this.map.project([clon, clat] as any);
          screenPts.push([p.x, p.y]);
        }
        if (!allValid || screenPts.length < 4) continue;

        // Skip degenerate projections
        const dx = screenPts[1][0] - screenPts[0][0];
        const dy = screenPts[2][1] - screenPts[0][1];
        if (Math.abs(dx) > 300 || Math.abs(dy) > 300) continue;
        if (Math.abs(dx) < 1 || Math.abs(dy) < 1) continue;

        // White cloud overlay — higher coverage = more opaque
        const alpha = coverage * 0.45;

        this.ctx.beginPath();
        this.ctx.moveTo(screenPts[0][0], screenPts[0][1]);
        for (let k = 1; k < screenPts.length; k++) {
          this.ctx.lineTo(screenPts[k][0], screenPts[k][1]);
        }
        this.ctx.closePath();
        this.ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        this.ctx.fill();
      }
    }
  }
}
