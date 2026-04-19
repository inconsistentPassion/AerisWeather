/**
 * RainEffect — Radar-driven rain overlay on the MapLibre globe.
 *
 * Rain falls vertically in screen space (straight down on screen).
 * Density scales with RainViewer radar alpha intensity.
 */

import maplibregl from 'maplibre-gl';

const TOTAL_DROPS = 10000;
const MAX_DRAWN = 6000;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [80, 130, 200, 0.18],
  [120, 170, 230, 0.28],
  [160, 210, 250, 0.38],
  [200, 230, 255, 0.48],
  [240, 248, 255, 0.58],
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
      length: 0.5 + Math.random() * 0.8,
    };
  }

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

      const tileUrls: string[] = [];
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 4; x++) {
          tileUrls.push(`${newPath}/2/2/${x}/${y}/2/1_1.png`);
        }
      }

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

      const tileW = this.radarW / 4;
      const tileH = this.radarH / 2;
      images.forEach((img, i) => {
        if (!img) return;
        const col = i % 4;
        const row = Math.floor(i / 4);
        offCtx.drawImage(img, col * tileW, row * tileH, tileW, tileH);
      });

      const imageData = offCtx.getImageData(0, 0, this.radarW, this.radarH);
      this.radarAlpha = new Float32Array(this.radarW * this.radarH);
      for (let i = 0; i < this.radarW * this.radarH; i++) {
        this.radarAlpha[i] = imageData.data[i * 4 + 3] / 255;
      }

      console.log('[Rain] Radar data loaded:', this.radarW + '×' + this.radarH);
    } catch (e) {
      console.warn('[Rain] Radar fetch failed:', e);
    }
  }

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
    return this.radarAlpha[i00] * (1-fx) * (1-fy) +
           this.radarAlpha[i01] * fx * (1-fy) +
           this.radarAlpha[i10] * (1-fx) * fy +
           this.radarAlpha[i11] * fx * fy;
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
        drop.length = 0.5 + Math.random() * 0.8;
      }

      const intensity = this.sampleRadar(drop.lon, drop.lat);
      if (intensity < 0.05) continue;

      // Viewport cull
      let inView: boolean;
      if (crossesDateLine) {
        inView = (drop.lon >= vpW - 3) || (drop.lon <= vpE + 3);
      } else {
        inView = drop.lon >= vpW - 3 && drop.lon <= vpE + 3;
      }
      if (!inView || drop.lat < vpS - 3 || drop.lat > vpN + 3) continue;
      if (!this.isFrontSide(drop.lon, drop.lat)) continue;

      const pt = this.map.project([drop.lon, drop.lat] as any);
      if (!pt) continue;

      // Rain falls straight down in screen space
      const streakLen = drop.length * sizeScale * 12;
      const headY = pt.y + drop.fall * streakLen;
      const tailY = pt.y + (drop.fall - 1) * streakLen;

      // Skip if streak is off-screen vertically
      if (tailY > ch + 20 || headY < -20) continue;

      const bin = Math.min(NUM_BINS - 1, Math.floor(intensity * NUM_BINS));
      const segs = binSegs[bin];
      let sc = binCounts[bin];
      if (sc >= maxSegs - 4) continue;

      segs[sc++] = pt.x; segs[sc++] = tailY;
      segs[sc++] = pt.x; segs[sc++] = headY;
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
