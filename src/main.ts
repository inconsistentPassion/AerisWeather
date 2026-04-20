/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 *
 * MapLibre GL JS  → globe, tiles, zoom, camera
 * deck.gl         → clouds (ScatterplotLayer), wind (PathLayer), rain (ScatterplotLayer)
 * All GPU-accelerated via deck.gl + MapboxOverlay.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { createUI } from './ui/UI';
import { WeatherManager } from './weather/WeatherManager';
import { DeckLayers } from './weather/DeckLayers';
import { RadarLayer } from './clouds/RadarLayer';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

async function init() {
  const container = document.getElementById('app')!;
  const uiContainer = document.getElementById('ui-overlay')!;

  container.style.width = '100%';
  container.style.height = '100%';

  const weather = new WeatherManager();

  // ── MapLibre globe ─────────────────────────────────────────────────
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [0, 20],
    zoom: 1.8,
    pitch: 52,
    bearing: -20,
    maxPitch: 80,
    attributionControl: false,
    renderWorldCopies: false,
    cancelPendingTileRequestsWhileZooming: true,
    maxTileCacheZoomLevels: 4,
    dragRotate: true,
    pitchWithRotate: true,
    touchZoomRotate: true,
    transformRequest: (url, resourceType) => {
      if (resourceType === 'Tile' && url.includes('rainviewer.com')) {
        const match = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
        if (match) {
          const z = parseInt(match[1]);
          const x = parseInt(match[2]);
          const y = parseInt(match[3]);
          if (z > 8) {
            const scale = 1 << (z - 8);
            return { url: url.replace(`/${z}/${x}/${y}.png`, `/8/${Math.floor(x/scale)}/${Math.floor(y/scale)}.png`) };
          }
        }
      }
      return { url };
    },
  });

  map.on('style.load', () => {
    try { (map as any).setProjection({ type: 'globe' }); }
    catch (e) { console.warn('setProjection failed:', e); }
  });

  await new Promise<void>((resolve) => map.on('load', () => resolve()));

  // ── Terrain (disabled on globe — MapLibre doesn't support both yet) ──
  // Uncomment below when using mercator projection instead of globe
  /*
  try {
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
    });
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.8 });
    map.addLayer({
      id: 'hillshade-layer', type: 'hillshade', source: 'terrain-dem',
      paint: {
        'hillshade-illumination-direction': 315,
        'hillshade-exaggeration': 0.6,
        'hillshade-shadow-color': 'rgba(0, 0, 10, 0.8)',
        'hillshade-highlight-color': 'rgba(80, 100, 140, 0.3)',
        'hillshade-accent-color': 'rgba(15, 20, 35, 0.5)',
      },
    });
  } catch (e) { console.warn('[Terrain] Failed:', e); }
  */

  map.on('error', (e) => {
    const msg = e.error?.message || '';
    // Suppress known globe projection / terrain warnings
    if (msg.includes('rainviewer') || msg.includes('404') || msg.includes('not supported')) return;
    if (msg.includes('globe projection') || msg.includes('Easing around')) return;
    if (msg.includes('calculateFogMatrix') || msg.includes('terrain')) return;
    console.error('MapLibre error:', e);
  });

  // ── deck.gl layers (via MapboxOverlay) ─────────────────────────────
  const deckLayers = new DeckLayers(weather);
  map.addControl(deckLayers.getControl() as any);
  deckLayers.onMapReady(map);

  // ── RainViewer radar (native MapLibre raster — separate from deck.gl) ──
  const radarLayer = new RadarLayer(map, weather);
  radarLayer.setVisible(true);

  // ── UI ─────────────────────────────────────────────────────────────
  createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => {
      weather.toggleLayer(layer, active);
      switch (layer) {
        case 'wind': deckLayers.setVisible('wind', active); break;
        case 'radar': radarLayer.setVisible(active); deckLayers.setVisible('radar', active); break;
        case 'clouds': deckLayers.setVisible('clouds', active); break;
      }
    },
    onCameraMode: (mode) => {
      // Note: easeTo not supported on globe projection, use flyTo
      if (mode === 'orbit') map.flyTo({ pitch: 49, bearing: -20, duration: 1000 });
      else if (mode === 'freeflight') map.flyTo({ pitch: 75, bearing: map.getBearing(), duration: 1000 });
    },
  });

  weather.loadInitial().catch(e => console.warn('[Weather] load failed:', e));

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space': e.preventDefault(); break;
      case 'KeyR': map.flyTo({ center: [0, 20], zoom: 1.8, pitch: 52, bearing: -20, duration: 1500 }); break;
      case 'Digit6': document.querySelector('[data-layer="clouds"]')?.dispatchEvent(new Event('click')); break;
      case 'Equal': case 'NumpadAdd': map.zoomIn(); break;
      case 'Minus': case 'NumpadSubtract': map.zoomOut(); break;
    }
  });
}

init().catch(console.error);
