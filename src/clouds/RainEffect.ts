/**
 * RainEffect — Radar-driven rain on the MapLibre globe.
 *
 * Downloads z10 RainViewer tiles for the current viewport (max sharpness).
 * Converts tile pixel positions to lon/lat using proper Mercator math.
 * Spawns rain drops at precipitation locations — only where radar shows rain.
 * Falls toward globe disc center in screen space.
 */

import maplibregl from 'maplibre-gl';

const MAX_DROPS = 8000;
const MAX_DRAWN = 5000;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const TILE_SIZE = 256;
const ZOOM = 10; // max sharpness

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
  intensity: number;
}

// Precipitation points extracted from radar tiles
interface PrecipPoint {
  lon: number;
  lat: number;
  intensity: number; // 0-1
}

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private visible = false;

  private drops: Drop[] = [];
  private precipPoints: PrecipPoint[] = [];
  private latestPath = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastTileFetch = 0;

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

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    this.loadRadar();
    this.refreshTimer = setInterval(() => this.loadRadar(), 10 * 60 * 1000);

    // Also refresh tiles when map moves significantly
    map.on('moveend', () => this.loadRadar());
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  /**
   * Mercator: lon/lat → tile x/y at zoom level
   */
  private static lonToTileX(lon: number, z: number): number {
    return Math.floor((lon + 180) / 360 * (1 << z));
  }

  private static latToTileY(lat: number, z: number): number {
    const latRad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * (1 << z));
  }

  /**
   * Mercator: tile pixel → lon/lat
   */
  private static tilePixelToLon(tx: number, px: number, z: number): number {
    const n = 1 << z;
    return (tx + px / TILE_SIZE) / n * 360 - 180;
  }

  private static tilePixelToLat(ty: number, py: number, z: number): number {
    const n = 1 << z;
    const y = (ty + py / TILE_SIZE) / n;
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
  }

  /**
   * Load z10 radar tiles for the current viewport and extract precipitation points.
   */
  private async loadRadar(): Promise<void> {
    const now = performance.now();
    if (now - this.lastTileFetch < 5000) return; // throttle
    this.lastTileFetch = now;

    try {
      const res = await fetch(RAINDVIEWER_API);
      if (!res.ok) return;
      const data = await res.json();
      const host = data.host || 'https://tilecache.rainviewer.com';
      const past = data.radar?.past || [];
      if (!past.length) return;

      const latest = past[past.length - 1];
      const basePath = `${host}${latest.path}/256`;
      if (basePath === this.latestPath) return;
      this.latestPath = basePath;

      // Get viewport bounds
      const bounds = this.map.getBounds();
      const z = ZOOM;

      // Calculate tile range for viewport
      const minTX = RainEffect.lonToTileX(bounds.getWest(), z);
      const maxTX = RainEffect.lonToTileX(bounds.getEast(), z);
      const minTY = RainEffect.latToTileY(bounds.getNorth(), z);
      const maxTY = RainEffect.latToTileY(bounds.getSouth(), z);

      // Fetch all tiles in viewport (max ~16 tiles typically)
      const tilePromises: Promise<void>[] = [];
      const points: PrecipPoint[] = [];
      const maxTiles = 25; // safety limit

      let count = 0;
      for (let ty = minTY; ty <= maxTY && count < maxTiles; ty++) {
        for (let tx = minTX; tx <= maxTX && count < maxTiles; tx++) {
          count++;
          const tileX = ((tx % (1 << z)) + (1 << z)) % (1 << z); // wrap
          const url = `${basePath}/${z}/${tileX}/${ty}/2/1_1.png`;

          tilePromises.push(this.extractPrecipFromTile(url, tileX, ty, z, points));
        }
      }

      await Promise.allSettled(tilePromises);

      this.precipPoints = points;
      console.log(`[Rain] ${points.length} precip points from ${count} z${z} tiles`);

      // Spawn drops at precip locations
      this.spawnDropsFromPrecip();
    } catch (e) {
      console.warn('[Rain] Radar load failed:', e);
    }
  }

  /**
   * Download a single radar tile and extract precipitation pixel locations.
   * Converts each non-zero pixel to lon/lat using Mercator math.
   */
  private extractPrecipFromTile(
    url: string, tx: number, ty: number, z: number,
    out: PrecipPoint[]
  ): Promise<void> {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = TILE_SIZE;
        c.height = TILE_SIZE;
        const cx = c.getContext('2d')!;
        cx.drawImage(img, 0, 0);
        const pixels = cx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;

        // Sample every 4th pixel for performance
        const step = 4;
        for (let py = 0; py < TILE_SIZE; py += step) {
          for (let px = 0; px < TILE_SIZE; px += step) {
            const i = (py * TILE_SIZE + px) * 4;
            const r = pixels[i], g = pixels[i+1], b = pixels[i+2], a = pixels[i+3];
            const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
            const intensity = lum * (a / 255);

            if (intensity > 0.05) {
              const lon = RainEffect.tilePixelToLon(tx, px, z);
              const lat = RainEffect.tilePixelToLat(ty, py, z);
              out.push({ lon, lat, intensity });
            }
          }
        }
        resolve();
      };
      img.onerror = () => resolve();
      img.src = url;
    });
  }

  /**
   * Spawn rain drops at precipitation locations.
   */
  private spawnDropsFromPrecip(): void {
    this.drops = [];
    if (!this.precipPoints.length) return;

    // Create multiple drops per precip point for density
    const dropsPerPoint = Math.max(1, Math.min(5, Math.floor(MAX_DROPS / this.precipPoints.length)));

    for (const pt of this.precipPoints) {
      for (let j = 0; j < dropsPerPoint && this.drops.length < MAX_DROPS; j++) {
        // Scatter drops around the precip point (±0.5° for natural spread)
        this.drops.push({
          lon: pt.lon + (Math.random() - 0.5) * 1.0,
          lat: pt.lat + (Math.random() - 0.5) * 1.0,
          fall: Math.random(),
          speed: 0.012 + Math.random() * 0.018,
          length: 0.5 + Math.random() * 0.8,
          intensity: pt.intensity,
        });
      }
    }
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
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.resizeObs.disconnect();
    this.canvas.remove();
  }

  private clear(): void {
    const d = devicePixelRatio;
    this.ctx.clearRect(0, 0, this.canvas.width / d, this.canvas.height / d);
  }

  private frame(): void {
    if (!this.visible || this.canvas.style.display === 'none') return;

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    this.ctx.clearRect(0, 0, cw, ch);

    if (!this.drops.length) return;

    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch() * Math.PI / 180;

    // Globe disc center on screen
    const scX = cw / 2, scY = ch / 2;
    const gR = Math.min(cw, ch) * 0.38 * Math.pow(2, zoom - 2.0);
    const dcX = scX;
    const dcY = scY + Math.sin(pitch) * gR * 0.5;

    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DRAWN / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) binSegs.push(new Float64Array(maxSegs));

    let drawn = 0;
    const sz = Math.max(0.5, Math.min(2, zoom / 5));

    for (let i = 0; i < this.drops.length && drawn < MAX_DRAWN; i++) {
      const d = this.drops[i];

      d.fall += d.speed;
      if (d.fall >= 1) {
        d.fall = 0; // reset fall, keep position (persistent precip location)
      }

      // Project to screen — same as wind particles
      const pt = this.map.project([d.lon, d.lat] as any);
      if (!pt) continue;

      // Inside globe disc
      const dx = pt.x - dcX, dy = pt.y - dcY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > gR) continue;

      // Rain direction: toward disc center
      let rdx = 0, rdy = 1;
      if (dist > 2) { rdx = -dx/dist; rdy = -dy/dist; }

      const sl = d.length * sz * 12;
      const ho = d.fall * sl, to = (d.fall-1)*sl;
      const hx = pt.x+rdx*ho, hy = pt.y+rdy*ho;
      const tx = pt.x+rdx*to, ty = pt.y+rdy*to;

      if ((hx-tx)**2+(hy-ty)**2 > 40000) continue;
      if (hy<-20||hy>ch+20||ty<-20||ty>ch+20) continue;

      const bin = Math.min(NUM_BINS-1, Math.floor(d.intensity*NUM_BINS));
      const segs = binSegs[bin];
      let sc = binCounts[bin];
      if (sc >= maxSegs-4) continue;
      segs[sc++]=tx; segs[sc++]=ty; segs[sc++]=hx; segs[sc++]=hy;
      binCounts[bin] = sc;
      drawn++;
    }

    this.ctx.lineCap = 'round';
    for (let b = 0; b < NUM_BINS; b++) {
      const count = binCounts[b];
      if (!count) continue;
      const segs = binSegs[b];
      const [r,g,bl,a] = BIN_COLORS[b];
      this.ctx.beginPath();
      for (let j = 0; j < count; j += 4) {
        this.ctx.moveTo(segs[j], segs[j+1]);
        this.ctx.lineTo(segs[j+2], segs[j+3]);
      }
      this.ctx.lineWidth = (0.5+b*0.35)*sz;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
