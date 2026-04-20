/**
 * RainEffect — deck.gl LineLayer-based rain visualization.
 */

import { LineLayer } from '@deck.gl/layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { DeckLayerManager } from './DeckLayerManager';

const MAX_DROPS = 4000;
const SPAWN_PER_FRAME = 120;
const TILE_PX = 256;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_INTERVAL = 10 * 60 * 1000;
const FRAME_INTERVAL = 16;

const BIN_COLORS: [number, number, number, number][] = [
  [90, 140, 210, 120],
  [130, 180, 235, 160],
  [170, 215, 255, 200],
  [210, 235, 255, 230],
  [245, 250, 255, 250],
];

interface PrecipCell {
  lon: number;
  lat: number;
  halfLon: number;
  halfLat: number;
  intensity: number;
}

interface Drop {
  lon: number;
  lat: number;
  fall: number;
  speed: number;
  length: number;
  intensity: number;
  age: number;
  maxAge: number;
}

interface RainSegment {
  sourcePosition: [number, number, number];
  targetPosition: [number, number, number];
  color: [number, number, number, number];
  width: number;
}

function pixelToLon(tileX: number, px: number, zoom: number): number {
  return ((tileX + px / TILE_PX) / (1 << zoom)) * 360 - 180;
}
function pixelToLat(tileY: number, py: number, zoom: number): number {
  const n = Math.PI - 2 * Math.PI * (tileY + py / TILE_PX) / (1 << zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export class RainEffect {
  private map: MapLibreMap;
  private manager: DeckLayerManager;
  private visible = false;
  private animId: number | null = null;
  private lastUpdate = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private cells: PrecipCell[] = [];
  private drops: Drop[] = [];

  constructor(map: MapLibreMap, manager: DeckLayerManager) {
    this.map = map;
    this.manager = manager;
    this.loadRadar();
    this.refreshTimer = setInterval(() => this.loadRadar(), REFRESH_INTERVAL);
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
      const tilesPerSide = 1 << zoom;
      const cells: PrecipCell[] = [];
      const CELL_STRIDE = 4;

      const tileUrls: Array<{ url: string; tx: number; ty: number }> = [];
      for (let ty = 0; ty < tilesPerSide; ty++) {
        for (let tx = 0; tx < tilesPerSide; tx++) {
          tileUrls.push({ url: `${basePath}/${zoom}/${tx}/${ty}/2/1_1.png`, tx, ty });
        }
      }

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
                    halfLat: cellSize * 0.5,
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
      console.log(`[Rain] ${cells.length} precip cells loaded`);
    } catch (e) {
      console.warn('[Rain] Radar load failed:', e);
    }
  }

  private isFrontSide(lon: number, lat: number): boolean {
    const c = this.map.getCenter();
    const cLat = c.lat * Math.PI / 180;
    const cLon = c.lng * Math.PI / 180;
    const pLat = lat * Math.PI / 180;
    const pLon = lon * Math.PI / 180;
    return Math.sin(cLat) * Math.sin(pLat) +
           Math.cos(cLat) * Math.cos(pLat) * Math.cos(pLon - cLon) > 0.1;
  }

  private spawnBatch(count: number): void {
    if (this.cells.length === 0) return;
    for (let i = 0; i < count; i++) {
      const cell = this.cells[Math.floor(Math.random() * this.cells.length)];
      if (Math.random() > cell.intensity) continue;
      const lon = cell.lon + (Math.random() - 0.5) * cell.halfLon * 2;
      const lat = cell.lat + (Math.random() - 0.5) * cell.halfLat * 2;
      if (!this.isFrontSide(lon, lat)) continue;
      this.drops.push({
        lon, lat,
        fall: Math.random() * 0.3,
        speed: 0.015 + Math.random() * 0.018 + cell.intensity * 0.008,
        length: 0.5 + Math.random() * 0.5 + cell.intensity * 0.3,
        intensity: cell.intensity,
        age: 0,
        maxAge: 50 + Math.floor(Math.random() * 50),
      });
    }
    if (this.drops.length > MAX_DROPS) {
      this.drops.splice(0, this.drops.length - MAX_DROPS);
    }
  }

  private frame(): void {
    if (!this.visible) {
      this.manager.removeLayer('rain-segments');
      return;
    }

    const now = performance.now();
    if (now - this.lastUpdate < FRAME_INTERVAL) {
      this.animId = requestAnimationFrame(() => this.frame());
      return;
    }
    this.lastUpdate = now;

    this.spawnBatch(SPAWN_PER_FRAME);
    const segments: RainSegment[] = [];

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age++;
      d.fall += d.speed;

      if (d.fall >= 1 || d.age >= d.maxAge) {
        this.drops[i] = this.drops[this.drops.length - 1];
        this.drops.pop();
        continue;
      }
      if (!this.isFrontSide(d.lon, d.lat)) continue;

      const dropOffset = d.length * 0.3;
      const headLat = d.lat - dropOffset * d.fall;
      const tailLat = d.lat - dropOffset * (d.fall - 1);
      if (Math.abs(headLat) > 90 || Math.abs(tailLat) > 90) continue;

      const bin = Math.min(BIN_COLORS.length - 1, Math.floor(d.intensity * BIN_COLORS.length));
      const [r, g, b, a] = BIN_COLORS[bin];
      const ageFade = d.age < 10 ? d.age / 10 : d.fall > 0.8 ? (1 - d.fall) / 0.2 : 1;
      const alpha = a * Math.max(0, ageFade);

      segments.push({
        sourcePosition: [d.lon, tailLat, 0],
        targetPosition: [d.lon, headLat, 0],
        color: [r, g, b, alpha],
        width: 0.5 + bin * 0.15,
      });
    }

    if (segments.length > 0) {
      this.manager.setLayer('rain-segments', new LineLayer<RainSegment>({
        id: 'rain-segments',
        data: segments,
        getSourcePosition: d => d.sourcePosition,
        getTargetPosition: d => d.targetPosition,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthUnits: 'pixels',
        pickable: false,
      }));
    } else {
      this.manager.removeLayer('rain-segments');
    }

    this.animId = requestAnimationFrame(() => this.frame());
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v && this.animId === null) {
      this.lastUpdate = 0;
      this.frame();
    } else if (!v && this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
      this.drops = [];
      this.manager.removeLayer('rain-segments');
    }
  }

  destroy(): void {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.manager.removeLayer('rain-segments');
  }
}
