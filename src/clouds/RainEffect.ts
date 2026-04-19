/**
 * RainEffect — Dynamic radar-driven rain on the MapLibre globe.
 *
 * Loads precipitation grids from RainViewer tiles and stores them as a
 * density map. Each frame, drops spawn randomly within areas where
 * precipitation exists, creating a natural evolving rain look.
 *
 * Back-face occlusion uses proper globe-space dot product with a
 * smooth limb fade so rain doesn't pop on/off at the horizon.
 */

import maplibregl from 'maplibre-gl';

// ── Config ────────────────────────────────────────────────────────────
const MAX_DROPS        = 6000;   // cap live drops
const SPAWN_PER_FRAME  = 180;    // new drops per frame (fills over ~1s)
const TILE_PX          = 256;
const RAINDVIEWER_API  = 'https://api.rainviewer.com/public/weather-maps.json';

// Intensity bins → color + opacity
const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [ 90, 140, 210, 0.18],   // light drizzle
  [130, 180, 235, 0.28],   // moderate
  [170, 215, 255, 0.40],   // heavy
  [210, 235, 255, 0.52],   // very heavy
  [245, 250, 255, 0.64],   // extreme
];

// ── Precipitation cell ────────────────────────────────────────────────
// A rectangular region of the radar grid where rain exists.
interface PrecipCell {
  lon: number;   // center lon
  lat: number;   // center lat
  halfLon: number; // half-width in lon degrees
  halfLat: number; // half-height in lat degrees
  intensity: number; // 0-1
}

// ── Live drop ─────────────────────────────────────────────────────────
interface Drop {
  lon: number; lat: number;
  fall: number;  // 0→1 animation progress
  speed: number;
  length: number;
  intensity: number;
  age: number;   // frames lived
  maxAge: number;
}

// ── Mercator tile helpers ─────────────────────────────────────────────
function pixelToLon(tileX: number, px: number, zoom: number): number {
  return ((tileX + px / TILE_PX) / (1 << zoom)) * 360 - 180;
}
function pixelToLat(tileY: number, py: number, zoom: number): number {
  const n = Math.PI - 2 * Math.PI * (tileY + py / TILE_PX) / (1 << zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ── RainEffect ────────────────────────────────────────────────────────

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private visible = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  // Precipitation cells (where rain exists)
  private cells: PrecipCell[] = [];

  // Live drops (pool)
  private drops: Drop[] = [];

  // Globe radius in screen pixels (computed each frame)
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
    this.refreshTimer = setInterval(() => this.loadRadar(), 10 * 60 * 1000);
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  // ── Radar loading (stores cells, not drops) ─────────────────────────

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

      // Use z3 tiles for better spatial resolution (64 tiles)
      const zoom = 3;
      const tilesPerSide = 1 << zoom; // 8
      const totalTiles = tilesPerSide * tilesPerSide; // 64

      const tileUrls: Array<{ url: string; tx: number; ty: number }> = [];
      for (let ty = 0; ty < tilesPerSide; ty++) {
        for (let tx = 0; tx < tilesPerSide; tx++) {
          tileUrls.push({
            url: `${basePath}/${zoom}/${tx}/${ty}/2/1_1.png`,
            tx, ty,
          });
        }
      }

      // Download all tiles and extract precipitation cells
      const cells: PrecipCell[] = [];
      const CELL_STRIDE = 4; // sample every N pixels

      await Promise.all(tileUrls.map(({ url, tx, ty }) =>
        new Promise<void>(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = TILE_PX; c.height = TILE_PX;
            const cx = c.getContext('2d')!;
            cx.drawImage(img, 0, 0);
            const px = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;

            for (let py = 0; py < TILE_PX; py += CELL_STRIDE) {
              for (let pxx = 0; pxx < TILE_PX; pxx += CELL_STRIDE) {
                const i = (py * TILE_PX + pxx) * 4;
                const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
                const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                const intensity = lum * (a / 255);
                if (intensity > 0.08) {
                  const lon = pixelToLon(tx, pxx + CELL_STRIDE / 2, zoom);
                  const lat = pixelToLat(ty, py + CELL_STRIDE / 2, zoom);
                  const cellSize = (360 / (1 << zoom)) / TILE_PX * CELL_STRIDE;
                  cells.push({
                    lon, lat,
                    halfLon: cellSize,
                    halfLat: cellSize * 0.5, // Mercator stretch
                    intensity: Math.min(1, intensity * 1.5),
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

      this.cells = cells;
      console.log(`[Rain] ${cells.length} precip cells from z${zoom} radar`);
    } catch (e) {
      console.warn('[Rain] Radar load failed:', e);
    }
  }

  // ── Occlusion ───────────────────────────────────────────────────────

  // ── Globe occlusion ──────────────────────────────────────────────────
  // Uses MapLibre's own isLocationOccluded from the internal transform.
  // This is the exact same check the renderer uses to cull tiles/symbols.

  /**
   * Globe visibility for a lat/lon point.
   * Returns 0 (behind globe) to 1 (front hemisphere).
   */
  private globeVisibility(lon: number, lat: number): number {
    // MapLibre's internal transform has isLocationOccluded
    const transform = (this.map as any).transform;
    if (transform?.isLocationOccluded) {
      const occluded = transform.isLocationOccluded({ lng: lon, lat });
      return occluded ? 0 : 1;
    }

    // Fallback: great circle distance from map center (works at pitch≈0)
    const c = this.map.getCenter();
    const cLat = c.lat * Math.PI / 180;
    const cLon = c.lng * Math.PI / 180;
    const pLat = lat * Math.PI / 180;
    const pLon = lon * Math.PI / 180;
    const dLat = pLat - cLat;
    const dLon = pLon - cLon;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(cLat) * Math.cos(pLat) * Math.sin(dLon / 2) ** 2;
    const angle = 2 * Math.asin(Math.min(1, Math.sqrt(a)));
    if (angle > 85 * Math.PI / 180) return 0;
    if (angle < 75 * Math.PI / 180) return 1;
    const t = 1 - (angle - 75 * Math.PI / 180) / (10 * Math.PI / 180);
    return t * t * (3 - 2 * t);
  }

  // ── Spawning ────────────────────────────────────────────────────────

  /**
   * Spawn drops at random precipitation cells that are visible.
   * Weighted by cell intensity so heavier rain areas get more drops.
   */
  private spawnBatch(count: number): void {
    if (this.cells.length === 0) return;

    for (let i = 0; i < count; i++) {
      // Pick a random cell, weighted by intensity
      // (simple approach: pick random, reject if rand > intensity)
      const cell = this.cells[Math.floor(Math.random() * this.cells.length)];
      if (Math.random() > cell.intensity) continue;

      // Spawn within the cell with some jitter
      const lon = cell.lon + (Math.random() - 0.5) * cell.halfLon * 2;
      const lat = cell.lat + (Math.random() - 0.5) * cell.halfLat * 2;

      // Check visibility
      const vis = this.globeVisibility(lon, lat);
      if (vis < 0.3) continue; // only spawn on clearly visible side

      const maxAge = 60 + Math.floor(Math.random() * 60);
      this.drops.push({
        lon, lat,
        fall: Math.random() * 0.3, // stagger start
        speed: 0.012 + Math.random() * 0.015 + cell.intensity * 0.008,
        length: 0.3 + Math.random() * 0.4 + cell.intensity * 0.3,
        intensity: cell.intensity,
        age: 0,
        maxAge,
      });
    }

    // Trim pool
    if (this.drops.length > MAX_DROPS) {
      this.drops.splice(0, this.drops.length - MAX_DROPS);
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

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

  // ── Frame ───────────────────────────────────────────────────────────

  private frame(): void {
    if (!this.visible || this.canvas.style.display === 'none') {
      if (this.visible) this.clear();
      return;
    }

    const dpr = devicePixelRatio;
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;
    this.ctx.clearRect(0, 0, cw, ch);

    // Spawn new drops this frame
    this.spawnBatch(SPAWN_PER_FRAME);

    // Globe projection estimate
    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch() * Math.PI / 180;
    this.globeRadius = Math.min(cw, ch) * 0.38 * Math.pow(2, zoom - 2.0);
    this.globeCenter.x = cw / 2;
    this.globeCenter.y = ch / 2 + Math.sin(pitch) * this.globeRadius * 0.5;

    // Guard against degenerate globe radius
    if (this.globeRadius < 10) return;

    // Bin segments by intensity
    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DROPS / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) binSegs.push(new Float64Array(maxSegs));

    let drawn = 0;
    const sz = Math.max(0.6, Math.min(2.0, zoom / 4.5));

    // Advance and draw drops
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];

      // Age out
      d.age++;
      d.fall += d.speed;
      if (d.fall >= 1 || d.age >= d.maxAge) {
        // Remove dead drop
        this.drops[i] = this.drops[this.drops.length - 1];
        this.drops.pop();
        continue;
      }

      // Globe visibility (back-face + limb fade)
      const vis = this.globeVisibility(d.lon, d.lat);
      if (vis < 0.01) continue; // fully behind globe

      // Project to screen
      const pt = this.map.project([d.lon, d.lat] as any);

      // Screen-space globe radius check (prevents edge artefacts)
      const gdx = pt.x - this.globeCenter.x;
      const gdy = pt.y - this.globeCenter.y;
      const gDist = Math.sqrt(gdx * gdx + gdy * gdy);
      if (gDist > this.globeRadius * 1.02) continue;

      // Fade at limb (screen-space supplement to globe-space fade)
      const limbFade = 1 - Math.pow(Math.min(1, gDist / (this.globeRadius * 0.98)), 3);
      const alpha = vis * limbFade;
      if (alpha < 0.02) continue;

      // Direction toward globe center (rain falls inward on globe)
      let rdx = 0, rdy = 1;
      if (gDist > 2) { rdx = -gdx / gDist; rdy = -gdy / gDist; }

      const sl = d.length * sz * 8;
      const headOffset = d.fall * sl;
      const tailOffset = (d.fall - 1) * sl;
      const hx = pt.x + rdx * headOffset;
      const hy = pt.y + rdy * headOffset;
      const tx = pt.x + rdx * tailOffset;
      const ty = pt.y + rdy * tailOffset;

      // Sanity clamp on segment length
      if ((hx - tx) ** 2 + (hy - ty) ** 2 > 40000) continue;
      if (hy < -20 || hy > ch + 20 || ty < -20 || ty > ch + 20) continue;

      // Bin by intensity
      const bin = Math.min(NUM_BINS - 1, Math.floor(d.intensity * NUM_BINS));
      const segs = binSegs[bin];
      const sc = binCounts[bin];
      if (sc >= maxSegs - 4) continue;
      segs[sc] = tx; segs[sc + 1] = ty;
      segs[sc + 2] = hx; segs[sc + 3] = hy;
      binCounts[bin] = sc + 4;
      drawn++;
    }

    // ── Draw ──────────────────────────────────────────────────────────
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
  }
}
