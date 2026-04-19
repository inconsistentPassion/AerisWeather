/**
 * RadarLayer — XWeather-style global radar/precipitation from RainViewer tiles.
 *
 * RainViewer provides free, no-auth, global radar tiles as PNGs.
 * Renders via MapLibre raster tiles — no canvas overlay needed.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const SOURCE_ID = 'rainviewer-radar';
const LAYER_ID = 'rainviewer-radar-layer';
const MAX_ZOOM = 8;

export class RadarLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private tileSourceAdded = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;

    // Fetch RainViewer tiles
    this.loadRainViewerTiles();
    this.refreshTimer = setInterval(() => this.loadRainViewerTiles(), 10 * 60 * 1000);
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

          this.map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            minzoom: 0,
            maxzoom: MAX_ZOOM + 0.99,
            paint: {
              'raster-opacity': 0.65,
              'raster-fade-duration': 0,
              'raster-resampling': 'linear',
              'raster-contrast': 0.15,
              'raster-brightness-min': 0.02,
              'raster-brightness-max': 0.95,
              'raster-saturation': 0.2,
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
  }

  destroy(): void {
    this.stop();
    try {
      if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
    } catch { /* cleanup */ }
  }
}
