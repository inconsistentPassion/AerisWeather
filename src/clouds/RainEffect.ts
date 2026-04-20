/**
 * RainEffect — Canvas 2D rain streaks on the MapLibre globe.
 *
 * Spawns rain drops in precipitation cells from RainViewer radar.
 * Renders as short line segments with globe occlusion.
 */

import maplibregl from 'maplibre-gl';

const MAX_DROPS = 5000;
const SPAWN_PER_FRAME = 150;
const TILE_PX = 256;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_INTERVAL = 10 * 60 * 1000;

const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [90, 140, 210, 0.18],
  [130, 180, 235, 0.28],
  [170, 215, 255, 0.40],
  [210, 235, 255, 0.52],
  [245, 250, 255, 0.64],
];

interface PrecipCell {
  lon: number; lat: number;
  halfLon: number; halfLat: number;
  intensity: number;
}

interface Drop {
  lon: number; lat: number;
  fall: number; speed: number;
  length: number; intensity: number;
  age: number; maxAge: number;
}

function pixelToLon(tx: number, px: number, z: number) {
  return ((tx + px / TILE_PX) / (1 << z)) * 360 - 180;
}
function pixelToLat(ty: number, py: number, z: number) {
  const n = Math.PI - 2 * Math.PI * (ty + py / TILE_PX) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private visible = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private cells: PrecipCell[] = [];
  private drops: Drop[] = [];
  private globeRadius = 0;
  private globeCenter = { x: 0, y: 0 };

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
    this.refreshTimer = setInterval(() => this.loadRadar(), REFRESH_INTERVAL);
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

      const zoom = 3;
      const cells: PrecipCell[] = [];
      const STRIDE = 4;

      const tiles: Array<{ url: string; tx: number; ty: number }> = [];
      for (let ty = 0; ty < (1 << zoom); ty++) {
        for (let tx = 0; tx < (1 << zoom); tx++) {
          tiles.push({ url: `${basePath}/${zoom}/${tx}/${ty}/2/1_1.png`, tx, ty });
        }
      }

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
            for (let py = 0; py < TILE_PX; py += STRIDE) {
              for (let pxx = 0; pxx < TILE_PX; pxx += STRIDE) {
                const i = (py * TILE_PX + pxx) * 4;
                const lum = (0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2]) / 255;
                const intensity = lum * (px[i+3] / 255);
                if (intensity > 0.08) {
                  const lon = pixelToLon(tx, pxx + STRIDE / 2, zoom);
                  const lat = pixelToLat(ty, py + STRIDE / 2, zoom);
                  const cs = (360 / (1 << zoom)) / TILE_PX * STRIDE;
                  cells.push({ lon, lat, halfLon: cs, halfLat: cs * 0.5, intensity: Math.min(1, intensity * 1.5) });
                }
              }
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        })
      ));

      this.cells = cells;
      console.log(`[Rain] ${cells.length} precip cells`);
    } catch (e) {
      console.warn('[Rain] Radar load failed:', e);
    }
  }

  private globeVisibility(lon: number, lat: number): number {
    const transform = (this.map as any).transform;
    if (transform?.isLocationOccluded) {
      return transform.isLocationOccluded({ lng: lon, lat }) ? 0 : 1;
    }
    const c = this.map.getCenter();
    const cLat = c.lat * Math.PI / 180, cLon = c.lng * Math.PI / 180;
    const pLat = lat * Math.PI / 180, pLon = lon * Math.PI / 180;
    const a = Math.sin((pLat - cLat) / 2) ** 2 +
              Math.cos(cLat) * Math.cos(pLat) * Math.sin((pLon - cLon) / 2) ** 2;
    const angle = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (angle > 85 * Math.PI / 180) return 0;
    if (angle < 75 * Math.PI / 180) return 1;
    const t = 1 - (angle - 75 * Math.PI / 180) / (10 * Math.PI / 180);
    return t * t * (3 - 2 * t);
  }

  private spawnBatch(count: number): void {
    if (!this.cells.length) return;
    for (let i = 0; i < count; i++) {
      const cell = this.cells[Math.floor(Math.random() * this.cells.length)];
      if (Math.random() > cell.intensity) continue;
      const lon = cell.lon + (Math.random() - 0.5) * cell.halfLon * 2;
      const lat = cell.lat + (Math.random() - 0.5) * cell.halfLat * 2;
      const vis = this.globeVisibility(lon, lat);
      if (vis < 0.3) continue;
      this.drops.push({
        lon, lat,
        fall: Math.random() * 0.3,
        speed: 0.012 + Math.random() * 0.015 + cell.intensity * 0.008,
        length: 0.3 + Math.random() * 0.4 + cell.intensity * 0.3,
        intensity: cell.intensity,
        age: 0,
        maxAge: 60 + Math.floor(Math.random() * 60),
      });
    }
    if (this.drops.length > MAX_DROPS) this.drops.splice(0, this.drops.length - MAX_DROPS);
  }

  private frame(): void {
    if (!this.visible) { this.animId = requestAnimationFrame(() => this.frame()); return; }

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr, ch = this.canvas.height / dpr;
    this.ctx.clearRect(0, 0, cw, ch);

    this.spawnBatch(SPAWN_PER_FRAME);

    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch() * Math.PI / 180;
    this.globeRadius = Math.min(cw, ch) * 0.38 * Math.pow(2, zoom - 2.0);
    this.globeCenter.x = cw / 2;
    this.globeCenter.y = ch / 2 + Math.sin(pitch) * this.globeRadius * 0.5;
    if (this.globeRadius < 10) { this.animId = requestAnimationFrame(() => this.frame()); return; }

    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DROPS / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) binSegs.push(new Float64Array(maxSegs));

    const sz = Math.max(0.6, Math.min(2.0, zoom / 4.5));

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age++; d.fall += d.speed;
      if (d.fall >= 1 || d.age >= d.maxAge) {
        this.drops[i] = this.drops[this.drops.length - 1];
        this.drops.pop();
        continue;
      }

      const vis = this.globeVisibility(d.lon, d.lat);
      if (vis < 0.01) continue;

      const pt = this.map.project([d.lon, d.lat] as any);
      const gdx = pt.x - this.globeCenter.x;
      const gdy = pt.y - this.globeCenter.y;
      const gDist = Math.sqrt(gdx * gdx + gdy * gdy);
      if (gDist > this.globeRadius * 1.02) continue;

      const limbFade = 1 - Math.pow(Math.min(1, gDist / (this.globeRadius * 0.98)), 3);
      const alpha = vis * limbFade;
      if (alpha < 0.02) continue;

      let rdx = 0, rdy = 1;
      if (gDist > 2) { rdx = -gdx / gDist; rdy = -gdy / gDist; }

      const sl = d.length * sz * 8;
      const hx = pt.x + rdx * d.fall * sl;
      const hy = pt.y + rdy * d.fall * sl;
      const tx = pt.x + rdx * (d.fall - 1) * sl;
      const ty = pt.y + rdy * (d.fall - 1) * sl;

      if ((hx - tx) ** 2 + (hy - ty) ** 2 > 40000) continue;

      const bin = Math.min(NUM_BINS - 1, Math.floor(d.intensity * NUM_BINS));
      const segs = binSegs[bin];
      const sc = binCounts[bin];
      if (sc >= maxSegs - 4) continue;
      segs[sc] = tx; segs[sc + 1] = ty;
      segs[sc + 2] = hx; segs[sc + 3] = hy;
      binCounts[bin] = sc + 4;
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
      this.ctx.lineWidth = (0.3 + b * 0.2) * sz;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }

    this.animId = requestAnimationFrame(() => this.frame());
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.style.display = v ? '' : 'none';
    if (v) {
      if (this.animId === null) this.frame();
    } else {
      if (this.animId !== null) { cancelAnimationFrame(this.animId); this.animId = null; }
      this.drops = [];
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  destroy(): void {
    if (this.animId !== null) cancelAnimationFrame(this.animId);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.resizeObs.disconnect();
    this.canvas.remove();
  }
}
