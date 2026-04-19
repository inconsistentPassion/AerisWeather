/**
 * RainEffect — Radar-driven rain on the MapLibre globe.
 *
 * Downloads z1 world tiles from RainViewer (4 tiles, always available).
 * Converts tile pixels to lon/lat using Mercator projection math.
 * Rain drops spawned at actual precipitation locations.
 * Front-side culling (same as wind particles) prevents rendering behind globe.
 * Zoom-adaptive density: subdivides drops when zoomed in for consistent detail.
 */

import maplibregl from 'maplibre-gl';

const BASE_DROPS = 8000;
const MAX_DRAWN = 5000;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const TILE_PX = 256;
const ZOOM = 1;

const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [80, 130, 200, 0.22],
  [120, 170, 230, 0.32],
  [160, 210, 250, 0.42],
  [200, 230, 255, 0.52],
  [240, 248, 255, 0.62],
];

interface Drop {
  lon: number; lat: number;
  fall: number; speed: number; length: number;
  intensity: number;
}

function pixelToLon(tileX: number, px: number): number {
  return ((tileX + px / TILE_PX) / (1 << ZOOM)) * 360 - 180;
}
function pixelToLat(tileY: number, py: number): number {
  const n = Math.PI - 2 * Math.PI * (tileY + py / TILE_PX) / (1 << ZOOM);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private drops: Drop[] = [];
  private visible = false;
  private latestPath = '';
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

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
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  private async loadRadar(): Promise<void> {
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

      const tiles = [
        { url: `${basePath}/1/0/0/2/1_1.png`, tx: 0, ty: 0 },
        { url: `${basePath}/1/1/0/2/1_1.png`, tx: 1, ty: 0 },
        { url: `${basePath}/1/0/1/2/1_1.png`, tx: 0, ty: 1 },
        { url: `${basePath}/1/1/1/2/1_1.png`, tx: 1, ty: 1 },
      ];

      const drops: Drop[] = [];

      await Promise.all(tiles.map(({ url, tx, ty }) =>
        new Promise<void>(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = TILE_PX; c.height = TILE_PX;
            const cx = c.getContext('2d')!;
            cx.drawImage(img, 0, 0);
            const px = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;

            for (let py = 0; py < TILE_PX; py += 3) {
              for (let pxx = 0; pxx < TILE_PX; pxx += 3) {
                const i = (py * TILE_PX + pxx) * 4;
                const r = px[i], g = px[i+1], b = px[i+2], a = px[i+3];
                const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
                const intensity = lum * (a / 255);
                if (intensity > 0.05) {
                  drops.push({
                    lon: pixelToLon(tx, pxx),
                    lat: pixelToLat(ty, py),
                    fall: Math.random(),
                    speed: 0.012 + Math.random() * 0.018,
                    length: 0.5 + Math.random() * 0.8,
                    intensity,
                  });
                }
              }
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        })
      ));

      if (drops.length > BASE_DROPS) {
        const step = drops.length / BASE_DROPS;
        const limited: Drop[] = [];
        for (let i = 0; i < drops.length; i += step) limited.push(drops[Math.floor(i)]);
        this.drops = limited;
      } else {
        this.drops = drops;
      }

      console.log(`[Rain] ${this.drops.length} base drops`);
    } catch (e) {
      console.warn('[Rain] Load failed:', e);
    }
  }

  /** Same front-side check as WindParticleLayer */
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
    if (!this.visible || this.canvas.style.display === 'none' || !this.drops.length) {
      if (this.visible) this.clear();
      return;
    }

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    this.ctx.clearRect(0, 0, cw, ch);

    const zoom = this.map.getZoom();
    const sz = Math.max(0.5, Math.min(2, zoom / 5));

    // Zoom-adaptive subdivision: more child drops at higher zoom
    const subdivide = Math.max(1, Math.min(6, Math.floor(Math.pow(2, zoom - 3))));
    const jitter = 0.5 / Math.pow(2, Math.max(0, zoom - 3)); // tighter scatter at high zoom

    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DRAWN / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) binSegs.push(new Float64Array(maxSegs));

    let drawn = 0;

    for (const d of this.drops) {
      if (drawn >= MAX_DRAWN) break;

      d.fall += d.speed;
      if (d.fall >= 1) d.fall = 0;

      // Generate sub-drops for zoom density
      for (let s = 0; s < subdivide && drawn < MAX_DRAWN; s++) {
        const slon = d.lon + (Math.random() - 0.5) * jitter;
        const slat = d.lat + (Math.random() - 0.5) * jitter;

        // Front-side cull (same as WindParticleLayer)
        if (!this.isFrontSide(slon, slat)) continue;

        const pt = this.map.project([slon, slat] as any);
        if (!pt) continue;

        // On-screen check
        if (pt.x < -20 || pt.x > cw + 20 || pt.y < -20 || pt.y > ch + 20) continue;

        // Rain direction: straight down in screen space
        const rdx = 0, rdy = 1;

        const sl = d.length * sz * 12;
        const ho = d.fall * sl, to = (d.fall - 1) * sl;
        const hx = pt.x, hy = pt.y + ho;
        const tx = pt.x, ty = pt.y + to;

        if (hy < -20 || hy > ch + 20 || ty < -20 || ty > ch + 20) continue;

        const bin = Math.min(NUM_BINS - 1, Math.floor(d.intensity * NUM_BINS));
        const segs = binSegs[bin];
        let sc = binCounts[bin];
        if (sc >= maxSegs - 4) continue;
        segs[sc++] = tx; segs[sc++] = ty; segs[sc++] = hx; segs[sc++] = hy;
        binCounts[bin] = sc;
        drawn++;
      }
    }

    this.ctx.lineCap = 'round';
    for (let b = 0; b < NUM_BINS; b++) {
      const count = binCounts[b];
      if (!count) continue;
      const segs = binSegs[b];
      const [r, g, bl, a] = BIN_COLORS[b];
      this.ctx.beginPath();
      for (let j = 0; j < count; j += 4) {
        this.ctx.moveTo(segs[j], segs[j + 1]);
        this.ctx.lineTo(segs[j + 2], segs[j + 3]);
      }
      this.ctx.lineWidth = (0.5 + b * 0.35) * sz;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
