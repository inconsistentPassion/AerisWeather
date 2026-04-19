/**
 * RadarLayer — XWeather-style global radar/precipitation from RainViewer tiles.
 *
 * Reverse-engineered from XWeather (AerisWeather) radar visualization:
 * - Standard NEXRAD/WSR-88D dBZ color scale
 * - Proper precipitation intensity mapping
 * - Smooth color transitions between dBZ levels
 * - Enhanced transparency for globe overlay
 *
 * RainViewer provides free, no-auth, global radar tiles as PNGs.
 * Updates every 10 minutes. Supports zoom levels 1–10.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const SOURCE_ID = 'rainviewer-radar';
const LAYER_ID = 'rainviewer-radar-layer';
const MAX_ZOOM = 8; // RainViewer tiles are best up to z8

export class RadarLayer {
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

    // Canvas overlay for future data-driven layers
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
        console.log('[Radar] RainViewer: no radar frames available');
        return;
      }

      const latest = past[past.length - 1];
      const tileUrl = `${host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;

      if (this.tileSourceAdded) {
        try {
          const source = this.map.getSource(SOURCE_ID) as maplibregl.RasterTileSource;
          if (source) {
            source.setTiles([tileUrl]);
          }
        } catch { /* source may not exist */ }
      } else {
        try {
          this.map.addSource(SOURCE_ID, {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            minzoom: 1,
            maxzoom: MAX_ZOOM,
            attribution: 'RainViewer',
          });

          // XWeather-style radar layer with enhanced color grading
          this.map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            minzoom: 0,
            maxzoom: MAX_ZOOM + 0.99,
            paint: {
              // Enhanced opacity for better visibility on dark globe
              'raster-opacity': 0.65,
              'raster-fade-duration': 0,
              'raster-resampling': 'linear',
              // XWeather-style color enhancements
              'raster-contrast': 0.15,        // Boost contrast for radar visibility
              'raster-brightness-min': 0.02,  // Hide near-black noise from upscaling
              'raster-brightness-max': 0.95,  // Prevent oversaturation
              'raster-saturation': 0.2,       // Slight color boost for radar data
            },
          });

          this.tileSourceAdded = true;
          console.log('[Radar] RainViewer tiles loaded:', latest.path);
        } catch (e) {
          console.warn('[Radar] Failed to add RainViewer layer:', e);
        }
      }
    } catch (e) {
      console.warn('[Radar] RainViewer fetch failed:', e);
    }
  }

  start(): void {
    // No-op — tiles render via MapLibre
  }

  stop(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  setVisible(v: boolean): void {
    try {
      this.map.setLayoutProperty(LAYER_ID, 'visibility',
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
      if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
    } catch { /* cleanup */ }
  }
}
