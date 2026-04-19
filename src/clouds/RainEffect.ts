/**
 * RainEffect — Radar-driven rain overlay on the MapLibre globe.
 *
 * Downloads z1 world tiles from RainViewer (4 tiles covering the globe),
 * composites into a single 512×256 intensity grid.
 * Samples from this grid using lon/lat (same coordinate system as wind particles).
 * Rain falls toward the globe disc center in screen space.
 */

import maplibregl from 'maplibre-gl';

const TOTAL_DROPS = 10000;
const MAX_DRAWN = 6000;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

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
}

export class RainEffect {
  private map: maplibregl.Map;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private drops: Drop[] = [];
  private visible = false;

  // Radar intensity grid (equirectangular, lon/lat mapped)
  private intensity: Float32Array | null = null;
  private gridW = 512;
  private gridH = 256;
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

    for (let i = 0; i < TOTAL_DROPS; i++) {
      this.drops.push(this.spawn());
    }

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

  private spawn(): Drop {
    return {
      lon: (Math.random() - 0.5) * 360,
      lat: (Math.random() - 0.5) * 150,
      fall: Math.random(),
      speed: 0.012 + Math.random() * 0.018,
      length: 0.5 + Math.random() * 0.8,
    };
  }

  /**
   * Load RainViewer z1 tiles (2×2 = 4 tiles covering the world).
   * Each tile is 256×256. Composited into 512×512.
   *
   * RainViewer tile addressing matches standard slippy map tiles:
   *   z=1, x=0..1, y=0..1
   *   y=0 → north (lat 85°N to equator)
   *   y=1 → south (equator to lat 85°S)
   *
   * We composite into a 512×256 equirectangular grid where:
   *   grid y=0 → lat 90°N, grid y=256 → lat 90°S
   *   grid x=0 → lon -180°, grid x=512 → lon 180°
   */
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

      // Download 4 z1 tiles: 2 columns × 2 rows
      const urls = [
        `${basePath}/1/0/0/2/1_1.png`, // NW
        `${basePath}/1/1/0/2/1_1.png`, // NE
        `${basePath}/1/0/1/2/1_1.png`, // SW
        `${basePath}/1/1/1/2/1_1.png`, // SE
      ];

      const imgs = await Promise.all(urls.map(u =>
        new Promise<HTMLImageElement | null>(r => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => r(img);
          img.onerror = () => r(null);
          img.src = u;
        })
      ));

      // Composite into 512×256 equirectangular grid
      const c = document.createElement('canvas');
      c.width = this.gridW;
      c.height = this.gridH;
      const cx = c.getContext('2d')!;
      cx.clearRect(0, 0, this.gridW, this.gridH);

      const tw = this.gridW / 2; // 256
      const th = this.gridH / 2; // 128

      // Place tiles: x=0,y=0 → top-left (NW), etc.
      if (imgs[0]) cx.drawImage(imgs[0], 0, 0, tw, th);       // NW
      if (imgs[1]) cx.drawImage(imgs[1], tw, 0, tw, th);      // NE
      if (imgs[2]) cx.drawImage(imgs[2], 0, th, tw, th);      // SW
      if (imgs[3]) cx.drawImage(imgs[3], tw, th, tw, th);     // SE

      // Extract intensity from RGB luminance × alpha
      const pixels = cx.getImageData(0, 0, this.gridW, this.gridH).data;
      this.intensity = new Float32Array(this.gridW * this.gridH);
      let nonZero = 0;
      for (let i = 0; i < this.gridW * this.gridH; i++) {
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        const a = pixels[i * 4 + 3];
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const val = lum * (a / 255);
        this.intensity[i] = val;
        if (val > 0.02) nonZero++;
      }
      console.log(`[Rain] Radar: ${this.gridW}×${this.gridH}, ${nonZero} px`);
    } catch (e) {
      console.warn('[Rain] Load failed:', e);
    }
  }

  /**
   * Sample radar intensity at lon/lat.
   * Grid mapping:
   *   x = (lon + 180) / 360 * gridW
   *   y = (90 - lat) / 180 * gridH
   * Same convention as wind's 360×180 grid.
   */
  private sample(lon: number, lat: number): number {
    if (!this.intensity) return 0;
    const nx = ((lon + 180) / 360) * this.gridW;
    const ny = ((90 - lat) / 180) * this.gridH;
    const x0 = Math.floor(nx) % this.gridW;
    const y0 = Math.max(0, Math.min(this.gridH - 1, Math.floor(ny)));
    const x1 = (x0 + 1) % this.gridW;
    const y1 = Math.min(this.gridH - 1, y0 + 1);
    const fx = nx - Math.floor(nx);
    const fy = ny - Math.floor(ny);
    const i = this.gridW;
    return this.intensity[y0*i+x0]*(1-fx)*(1-fy) + this.intensity[y0*i+x1]*fx*(1-fy) +
           this.intensity[y1*i+x0]*(1-fx)*fy + this.intensity[y1*i+x1]*fx*fy;
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
        d.lon = (Math.random() - 0.5) * 360;
        d.lat = (Math.random() - 0.5) * 150;
        d.fall = 0;
        d.speed = 0.012 + Math.random() * 0.018;
        d.length = 0.5 + Math.random() * 0.8;
      }

      const intensity = this.sample(d.lon, d.lat);
      if (intensity < 0.03) continue;

      const pt = this.map.project([d.lon, d.lat] as any);
      if (!pt) continue;

      const dx = pt.x - dcX, dy = pt.y - dcY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > gR) continue;

      let rdx = 0, rdy = 1;
      if (dist > 2) { rdx = -dx/dist; rdy = -dy/dist; }

      const sl = d.length * sz * 12;
      const ho = d.fall * sl, to = (d.fall-1)*sl;
      const hx = pt.x+rdx*ho, hy = pt.y+rdy*ho;
      const tx = pt.x+rdx*to, ty = pt.y+rdy*to;

      if ((hx-tx)**2+(hy-ty)**2 > 40000) continue;
      if (hy<-20||hy>ch+20||ty<-20||ty>ch+20) continue;
      if (hx<-20||hx>cw+20||tx<-20||tx>cw+20) continue;

      const bin = Math.min(NUM_BINS-1, Math.floor(intensity*NUM_BINS));
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
