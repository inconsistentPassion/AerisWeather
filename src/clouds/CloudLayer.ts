/**
 * CloudLayer — Global cloud/precipitation from RainViewer tiles + Open-Meteo data overlay.
 *
 * RainViewer provides free, no-auth, global radar/satellite tiles as PNGs.
 * One API call gets the latest frame URL, then tiles load like any MapLibre raster layer.
 * Updates every 10 minutes.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';

export class CloudLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animId: number | null = null;
  private resizeObs: ResizeObserver;
  private tileSourceAdded = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    // Canvas overlay for data-driven clouds (Open-Meteo fallback)
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', top: '0', left: '0',
      width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '0',
    });
    map.getContainer().appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(map.getContainer());
    this.resize();

    // Fetch RainViewer tiles
    this.loadRainViewerTiles();
    this.refreshTimer = setInterval(() => this.loadRainViewerTiles(), 10 * 60 * 1000);
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

  /** Fetch latest RainViewer frame and add as MapLibre raster tiles */
  private async loadRainViewerTiles(): Promise<void> {
    try {
      const res = await fetch(RAINDVIEWER_API);
      if (!res.ok) return;
      const data = await res.json();

      const host = data.host || 'https://tilecache.rainviewer.com';
      const past = data.radar?.past || [];

      if (past.length === 0) {
        console.log('[Clouds] RainViewer: no radar frames available');
        return;
      }

      const latest = past[past.length - 1];
      const tileUrl = `${host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;

      if (this.tileSourceAdded) {
        // Update existing source with new tile URL
        try {
          const source = this.map.getSource('rainviewer-clouds') as maplibregl.RasterTileSource;
          if (source) {
            source.setTiles([tileUrl]);
          }
        } catch { /* source may not exist */ }
      } else {
        // Add new source + layer
        try {
          this.map.addSource('rainviewer-clouds', {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            minzoom: 1,
            maxzoom: 10,
            attribution: 'RainViewer',
          });

          this.map.addLayer({
            id: 'rainviewer-clouds-layer',
            type: 'raster',
            source: 'rainviewer-clouds',
            paint: {
              'raster-opacity': 0.55,
              'raster-fade-duration': 0,
              'raster-hue-rotate': 0,
            },
          });

          this.tileSourceAdded = true;
          console.log('[Clouds] RainViewer tiles loaded:', latest.path);
        } catch (e) {
          console.warn('[Clouds] Failed to add RainViewer layer:', e);
        }
      }
    } catch (e) {
      console.warn('[Clouds] RainViewer fetch failed:', e);
    }
  }

  start(): void {
    // No-op — tiles render via MapLibre, no animation loop needed
  }

  stop(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  setVisible(v: boolean): void {
    try {
      this.map.setLayoutProperty('rainviewer-clouds-layer', 'visibility',
        v ? 'visible' : 'none');
    } catch { /* layer may not exist yet */ }
    this.canvas.style.display = v ? '' : 'none';
    if (v) this.clear();
  }

  destroy(): void {
    this.stop();
    this.resizeObs.disconnect();
    this.canvas.remove();
    try {
      if (this.map.getLayer('rainviewer-clouds-layer')) this.map.removeLayer('rainviewer-clouds-layer');
      if (this.map.getSource('rainviewer-clouds')) this.map.removeSource('rainviewer-clouds');
    } catch { /* cleanup */ }
  }
}
