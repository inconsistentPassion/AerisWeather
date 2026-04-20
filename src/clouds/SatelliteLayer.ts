/**
 * SatelliteLayer — Global IR satellite cloud imagery from RainViewer.
 *
 * RainViewer provides free, no-auth global satellite tiles as PNGs.
 * Renders via MapLibre raster tiles — smooth imagery, not dots.
 * Refreshes every 10 minutes with latest satellite frame.
 */

import maplibregl from 'maplibre-gl';

const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const SOURCE_ID = 'satellite-ir';
const LAYER_ID = 'satellite-ir-layer';

export class SatelliteLayer {
  private map: maplibregl.Map;
  private tileSourceAdded = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(map: maplibregl.Map) {
    this.map = map;
    this.loadSatelliteTiles();
    this.refreshTimer = setInterval(() => this.loadSatelliteTiles(), 10 * 60 * 1000);
  }

  private async loadSatelliteTiles(): Promise<void> {
    try {
      const res = await fetch(RAINDVIEWER_API);
      if (!res.ok) return;
      const data = await res.json();

      const host = data.host || 'https://tilecache.rainviewer.com';
      const satellite = data.satellite?.infrared || [];

      if (satellite.length === 0) {
        console.log('[Satellite] No satellite frames available');
        return;
      }

      const latest = satellite[satellite.length - 1];
      const tileUrl = `${host}${latest.path}/256/{z}/{x}/{y}/0/1_1.png`;

      if (this.tileSourceAdded) {
        try {
          const source = this.map.getSource(SOURCE_ID) as maplibregl.RasterTileSource;
          if (source) source.setTiles([tileUrl]);
          console.log('[Satellite] Updated to:', latest.path);
        } catch { /* source may not exist */ }
      } else {
        try {
          this.map.addSource(SOURCE_ID, {
            type: 'raster',
            tiles: [tileUrl],
            tileSize: 256,
            minzoom: 1,
            maxzoom: 8,
            attribution: 'RainViewer Satellite',
          });

          this.map.addLayer({
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            minzoom: 0,
            maxzoom: 9,
            paint: {
              'raster-opacity': 0.55,
              'raster-fade-duration': 200,
              'raster-resampling': 'linear',
              'raster-contrast': 0.2,
              'raster-brightness-min': 0.0,
              'raster-brightness-max': 0.9,
              'raster-saturation': -0.8,  // desaturate — IR is grayscale-ish
              'raster-hue-rotate': 200,   // tint blue for cold cloud tops
            },
          });

          this.tileSourceAdded = true;
          console.log('[Satellite] Layer added:', latest.path);
        } catch (e) {
          console.warn('[Satellite] Failed to add layer:', e);
        }
      }
    } catch (e) {
      console.warn('[Satellite] Fetch failed:', e);
    }
  }

  setVisible(v: boolean): void {
    try {
      this.map.setLayoutProperty(LAYER_ID, 'visibility', v ? 'visible' : 'none');
    } catch { /* layer may not exist yet */ }
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    try {
      if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
    } catch { /* cleanup */ }
  }
}
