/**
 * RainEffect — Radar-driven rain overlay on the MapLibre globe.
 *
 * Rain falls TOWARD the globe's visible disc center in screen space.
 * Intensity driven by RainViewer radar tile luminance (RGB + alpha).
 * Only renders where radar shows precipitation.
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

  // Radar intensity grid (sampled from tile RGB luminance × alpha)
  private radarIntensity: Float32Array | null = null;
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

      // Build z2 tile URLs: 4 columns × 2 rows
      // RainViewer format: {host}{path}/256/{z}/{x}/{y}/{color}/{options}.png
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

      // Sample BOTH RGB luminance and alpha for intensity
      // RainViewer encodes intensity in color (green=light → red=heavy) AND alpha
      const imageData = offCtx.getImageData(0, 0, this.radarW, this.radarH);
      this.radarIntensity = new Float32Array(this.radarW * this.radarH);
      let nonZero = 0;
      for (let i = 0; i < this.radarW * this.radarH; i++) {
        const r = imageData.data[i * 4];
        const g = imageData.data[i * 4 + 1];
        const b = imageData.data[i * 4 + 2];
        const a = imageData.data[i * 4 + 3];

        // Perceived brightness of the RGB color (0-255 → 0-1)
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        // Combine: intensity = how bright AND how opaque
        // More opaque + brighter color = heavier precipitation
        const intensity = luminance * (a / 255);
        this.radarIntensity[i] = intensity;
        if (intensity > 0.02) nonZero++;
      }

      console.log(`[Rain] Radar loaded: ${this.radarW}×${this.radarH}, ${nonZero} pixels with data`);
    } catch (e) {
      console.warn('[Rain] Radar fetch failed:', e);
    }
  }

  private sampleRadar(lon: number, lat: number): number {
    if (!this.radarIntensity) return 0;
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
    return this.radarIntensity[i00] * (1-fx) * (1-fy) +
           this.radarIntensity[i01] * fx * (1-fy) +
           this.radarIntensity[i10] * (1-fx) * fy +
           this.radarIntensity[i11] * fx * fy;
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

    // ── Find the globe disc center on screen ─────────────────────
    // The map center always projects to screen center, but the actual
    // visible globe disc center shifts with pitch.
    // At pitch 0: disc center = screen center
    // At pitch > 0: disc shifts down (toward camera nadir)
    const screenCenterX = cw / 2;
    const screenCenterY = ch / 2;

    // Globe radius on screen (empirically: ~40% of min dimension at zoom 2)
    const zoomScale = Math.pow(2, zoom - 2.0);
    const globeRadius = Math.min(cw, ch) * 0.38 * zoomScale;

    // Disc center offset: camera tilts forward, globe shifts down on screen
    // The offset is proportional to sin(pitch) × globeRadius
    const discCenterX = screenCenterX;
    const discCenterY = screenCenterY + Math.sin(pitch) * globeRadius * 0.6;

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
      if (intensity < 0.03) continue; // only rain where radar shows precipitation

      // Viewport cull
      let inView: boolean;
      if (crossesDateLine) {
        inView = (drop.lon >= vpW - 3) || (drop.lon <= vpE + 3);
      } else {
        inView = drop.lon >= vpW - 3 && drop.lon <= vpE + 3;
      }
      if (!inView || drop.lat < vpS - 3 || drop.lat > vpN + 3) continue;

      const pt = this.map.project([drop.lon, drop.lat] as any);
      if (!pt) continue;

      // Check if inside the globe disc
      const dxFromDisc = pt.x - discCenterX;
      const dyFromDisc = pt.y - discCenterY;
      const distFromDisc = Math.sqrt(dxFromDisc * dxFromDisc + dyFromDisc * dyFromDisc);
      if (distFromDisc > globeRadius) continue; // behind globe edge

      // Rain direction: toward disc center (radial gravity toward earth)
      let rdx = 0, rdy = 1; // default: straight down
      if (distFromDisc > 2) {
        rdx = -dxFromDisc / distFromDisc;
        rdy = -dyFromDisc / distFromDisc;
      }

      const streakLen = drop.length * sizeScale * 12;
      const headOff = drop.fall * streakLen;
      const tailOff = (drop.fall - 1) * streakLen;

      const headX = pt.x + rdx * headOff;
      const headY = pt.y + rdy * headOff;
      const tailX = pt.x + rdx * tailOff;
      const tailY = pt.y + rdy * tailOff;

      // Skip degenerate streaks
      const sdx = headX - tailX, sdy = headY - tailY;
      if (sdx * sdx + sdy * sdy > 200 * 200) continue;

      // Skip off-screen
      if (headY < -20 || headY > ch + 20 || tailY < -20 || tailY > ch + 20) continue;
      if (headX < -20 || headX > cw + 20 || tailX < -20 || tailX > cw + 20) continue;

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
      this.ctx.lineWidth = (0.5 + b * 0.35) * sizeScale;
      this.ctx.strokeStyle = `rgba(${r},${g},${bl},${a})`;
      this.ctx.stroke();
    }
  }
}
