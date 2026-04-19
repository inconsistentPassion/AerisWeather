/**
 * RainEffect — Rain overlay driven by actual RainViewer radar data.
 *
 * - Fetches RainViewer radar frame and samples tile colors for precipitation
 * - Rain falls PERPENDICULAR to globe surface (world-space normal → screen projection)
 * - Density scales with radar alpha intensity
 */

import maplibregl from 'maplibre-gl';

const TOTAL_DROPS = 8000;
const MAX_DRAWN = 5000;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

// Intensity bins
const NUM_BINS = 4;
const BIN_COLORS: [number, number, number, number][] = [
  [100, 140, 200, 0.18],  // 0: light
  [140, 185, 235, 0.30],  // 2: moderate
  [180, 215, 250, 0.42],  // 2: heavy
  [220, 240, 255, 0.55],  // 3: very heavy
];

interface Drop {
  lon: number;
  lat: number;
  fall: number;
  speed: number;
  length: number;
}

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private drops: Drop[] = [];
  private visible = false;

  // Radar tile data — sampled from RainViewer
  private radarAlpha: Float32Array | null = null;
  private radarW = 512;
  private radarH = 256;
  private latestTileUrl = '';
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

    for (let i = 0; i < TOTAL_DROPS; i++) {
      this.drops.push(this.spawn());
    }

    // Fetch radar data
    this.loadRadarData();
    this.refreshTimer = setInterval(() => this.loadRadarData(), 10 * 60 * 1000);
  }

  private resize(): void {
    const r = this.map.getContainer().getBoundingClientRect();
    const d = devicePixelRatio;
    this.canvas.width = r.width * d;
    this.canvas.height = r.height * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  private spawn(): Drop {
    return {
      lon: (Math.random() - 0.5) * 360,
      lat: (Math.random() - 0.5) * 150,
      fall: Math.random(),
      speed: 0.012 + Math.random() * 0.018,
      length: 0.6 + Math.random() * 0.8,
    };
  }

  /**
   * Fetch RainViewer radar frame and decode a global tile into alpha values.
   * Downloads a low-res composite tile and extracts the alpha channel as a
   * 512×256 precipitation grid (lon × lat, equirectangular).
   */
  private async loadRadarData(): Promise<void> {
    try {
      const res = await fetch(RAINDVIEWER_API);
      if (!res.ok) return;
      const data = await res.json();
      const host = data.host || 'https://tilecache.rainviewer.com';
      const past = data.radar?.past || [];
      if (past.length === 0) return;

      const latest = past[past.length - 1];
      const newPath = `${host}${latest.path}/256`;
      if (newPath === this.latestTileUrl) return;
      this.latestTileUrl = newPath;

      // Download a low-zoom tile that covers a large area.
      // z2 = 4×4 tiles covering the whole world. We download the
      // "whole world" approximation by fetching a few tiles and compositing.
      // Simpler: use z1 (2×2 tiles). Each is 256×256.
      // Even simpler: use the z0 tile (single 256×256 for the whole world).
      // RainViewer might not have z0. Use z2 which covers 1/16 of the world per tile.
      // Best: download multiple z2 tiles and composite into 512×256.

      const tileUrls: string[] = [];
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 4; x++) {
          tileUrls.push(`${newPath}/2/{z}/{x}/{y}/2/1_1.png`
            .replace('{z}', '2').replace('{x}', String(x)).replace('{y}', String(y)));
        }
      }

      // Download all 8 tiles and composite into a 512×256 canvas
      const offscreen = document.createElement('canvas');
      offscreen.width = this.radarW;
      offscreen.height = this.radarH;
      const offCtx = offscreen.getContext('2d')!;
      offCtx.clearRect(0, 0, this.radarW, this.radarH);

      const images = await Promise.all(tileUrls.map(url =>
        new Promise<HTMLImageElement | null>(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = url;
        })
      ));

      // Place tiles: 4 columns × 2 rows, each 128×128 in our 512×256 canvas
      const tileW = this.radarW / 4;
      const tileH = this.radarH / 2;
      images.forEach((img, i) => {
        if (!img) return;
        const col = i % 4;
        const row = Math.floor(i / 4);
        offCtx.drawImage(img, col * tileW, row * tileH, tileW, tileH);
      });

      // Extract alpha channel as precipitation intensity
      const imageData = offCtx.getImageData(0, 0, this.radarW, this.radarH);
      this.radarAlpha = new Float32Array(this.radarW * this.radarH);
      for (let i = 0; i < this.radarW * this.radarH; i++) {
        // Alpha is at index i*4 + 3
        this.radarAlpha[i] = imageData.data[i * 4 + 3] / 255;
      }

      console.log('[Rain] Radar data loaded:', this.radarW + '×' + this.radarH);
    } catch (e) {
      console.warn('[Rain] Radar fetch failed:', e);
    }
  }

  /** Sample radar intensity at lon/lat (0–1, from alpha channel) */
  private sampleRadar(lon: number, lat: number): number {
    if (!this.radarAlpha) return 0;
    const normLon = ((lon + 180) % 360 + 360) % 360;
    const x = (normLon / 360) * this.radarW;
    const y = ((90 - lat) / 180) * this.radarH;
    const x0 = Math.floor(x) % this.radarW;
    const y0 = Math.max(0, Math.min(this.radarH - 1, Math.floor(y)));
    const x1 = (x0 + 1) % this.radarW;
    const y1 = Math.min(this.radarH - 1, y0 + 1);
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const i00 = y0 * this.radarW + x0, i01 = y0 * this.radarW + x1;
    const i10 = y1 * this.radarW + x0, i11 = y1 * this.radarW + x1;
    return this.radarAlpha[i00] * (1 - fx) * (1 - fy) +
           this.radarAlpha[i01] * fx * (1 - fy) +
           this.radarAlpha[i10] * (1 - fx) * fy +
           this.radarAlpha[i11] * fx * fy;
  }

  /**
   * Get rain direction in screen space — perpendicular to globe surface.
   *
   * Uses Mercator z coordinate to project a point below the surface.
   * The screen-space vector from surface→below is the fall direction.
   */
  private getRainDirection(lon: number, lat: number): { dx: number; dy: number } | null {
    // Access the internal transform for mercator→screen projection with altitude
    const t = (this.map as any)._transform;
    if (!t || !t.project) return null;

    // Surface point (z = 0)
    const surfMc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
    const surfScreen = t.project(surfMc);

    // Point below surface (negative altitude = toward globe center = "down")
    const belowMc = maplibregl.MercatorCoordinate.fromLngLat({ lng: lon, lat }, -1000);
    const belowScreen = t.project(belowMc);

    const dx = belowScreen.x - surfScreen.x;
    const dy = belowScreen.y - surfScreen.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.3) return null;

    return { dx: dx / len, dy: dy / len };
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

    const bounds = this.map.getBounds();
    const vpW = bounds.getWest(), vpE = bounds.getEast();
    const vpS = bounds.getSouth(), vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    const binSegs: Float64Array[] = [];
    const binCounts = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DRAWN / NUM_BINS) * 4;
    for (let b = 0; b < NUM_BINS; b++) {
      binSegs.push(new Float64Array(maxSegs));
    }

    let drawn = 0;
    const zoom = this.map.getZoom();
    const sizeScale = Math.max(0.5, Math.min(2, zoom / 5));

    for (let i = 0; i < this.drops.length && drawn < MAX_DRAWN; i++) {
      const drop = this.drops[i];

      drop.fall += drop.speed;
      if (drop.fall >= 1) {
        drop.lon = (Math.random() - 0.5) * 360;
        drop.lat = (Math.random() - 0.5) * 150;
        drop.fall = 0;
        drop.speed = 0.012 + Math.random() * 0.018;
        drop.length = 0.6 + Math.random() * 0.8;
      }

      // Sample radar intensity
      const intensity = this.sampleRadar(drop.lon, drop.lat);
      if (intensity < 0.05) continue; // skip no-precip areas

      // Viewport cull
      let inView: boolean;
      if (crossesDateLine) {
        inView = (drop.lon >= vpW - 3) || (drop.lon <= vpE + 3);
      } else {
        inView = drop.lon >= vpW - 3 && drop.lon <= vpE + 3;
      }
      if (!inView || drop.lat < vpS - 3 || drop.lat > vpN + 3) continue;
      if (!this.isFrontSide(drop.lon, drop.lat)) continue;

      // Project surface point
      const pt = this.map.project([drop.lon, drop.lat] as any);
      if (!pt) continue;

      // Perpendicular direction (toward globe center in screen space)
      const dir = this.getRainDirection(drop.lon, drop.lat);
      if (!dir) continue;

      // Streak: tail → head along the perpendicular direction
      const streakLen = drop.length * sizeScale * 10;
      const headOff = drop.fall * streakLen;
      const tailOff = (drop.fall - 1) * streakLen;

      const headX = pt.x + dir.dx * headOff;
      const headY = pt.y + dir.dy * headOff;
      const tailX = pt.x + dir.dx * tailOff;
      const tailY = pt.y + dir.dy * tailOff;

      // Skip degenerate
      const sdx = headX - tailX, sdy = headY - tailY;
      if (sdx * sdx + sdy * sdy > 150 * 150) continue;

      // Intensity bin
      const bin = Math.min(NUM_BINS - 1, Math.floor(intensity * NUM_BINS));
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
      this.ctx.lineWidth = (0.7 + b * 0.4) * sizeScale;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
