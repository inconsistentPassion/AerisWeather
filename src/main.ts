/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 *
 * MapLibre GL JS  → globe, tiles, zoom, camera, atmosphere
 * Custom layers   → wind particles, radar, rain, atmosphere glow
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { createUI } from './ui/UI';
import { WeatherManager } from './weather/WeatherManager';
import { WindParticleLayer } from './weather/WindParticleLayer';
import { RadarLayer } from './clouds/RadarLayer';
import { RainEffect } from './clouds/RainEffect';
import { createAtmosphereLayer } from './scene/AtmosphereLayer';

// ── Mapbox-inspired dark style with enhanced terrain ────────────────
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
      // Cap RainViewer tile requests at z8
      if (resourceType === 'Tile' && url.includes('rainviewer.com')) {
        const match = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
        if (match) {
          const z = parseInt(match[1]);
          const x = parseInt(match[2]);
          const y = parseInt(match[3]);
          if (z > 8) {
            const scale = 1 << (z - 8);
            const cx = Math.floor(x / scale);
            const cy = Math.floor(y / scale);
            const capped = url.replace(`/${z}/${x}/${y}.png`, `/8/${cx}/${cy}.png`);
            return { url: capped };
          }
        }
      }
      return { url };
    },
  });

  // Globe projection
  map.on('style.load', () => {
    try {
      (map as any).setProjection({ type: 'globe' });
    } catch (e) {
      console.warn('setProjection failed:', e);
    }
  });

  // ── Wait for map ───────────────────────────────────────────────────
  await new Promise<void>((resolve) => map.on('load', () => resolve()));

  // ── Custom atmosphere layer (Rayleigh scattering) ──────────────────
  try {
    const atmosphereLayer = createAtmosphereLayer();
    map.addLayer(atmosphereLayer);
    console.log('[Atmosphere] Rayleigh scattering layer added');
  } catch (e) {
    console.warn('[Atmosphere] Layer failed:', e);
  }

  // ── 3D Terrain + hillshade (single shared DEM source) ──────────────
  try {
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
    });
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.8 });
    console.log('[Terrain] 3D elevation enabled');

    map.addLayer({
      id: 'hillshade-layer',
      type: 'hillshade',
      source: 'terrain-dem',
      paint: {
        'hillshade-illumination-direction': 315,
        'hillshade-exaggeration': 0.6,
        'hillshade-shadow-color': 'rgba(0, 0, 10, 0.8)',
        'hillshade-highlight-color': 'rgba(80, 100, 140, 0.3)',
        'hillshade-accent-color': 'rgba(15, 20, 35, 0.5)',
      },
    });
    console.log('[Hillshade] Terrain relief shading enabled');
  } catch (e) {
    console.warn('[Terrain] Failed:', e);
  }

  // ── Suppress non-critical tile errors ──────────────────────────────
  map.on('error', (e) => {
    const msg = e.error?.message || e.error?.toString() || '';
    if (msg.includes('rainviewer') || msg.includes('zoom level') ||
        msg.includes('404') || msg.includes('not supported')) {
      return;
    }
    console.error('MapLibre error:', e);
  });

  // ── Weather layers ─────────────────────────────────────────────────
  const windParticles = new WindParticleLayer(map, weather);
  const radarLayer = new RadarLayer(map, weather);
  const rainEffect = new RainEffect(map);

  radarLayer.setVisible(true);
  rainEffect.setVisible(true);

  // ── UI ─────────────────────────────────────────────────────────────
  const ui = createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => {
      weather.toggleLayer(layer, active);

      switch (layer) {
        case 'wind':
          windParticles.setVisible(active);
          break;
        case 'radar':
          radarLayer.setVisible(active);
          rainEffect.setVisible(active);
          break;
      }
    },
    onCameraMode: (mode) => {
      if (mode === 'orbit') {
        map.easeTo({ pitch: 49, bearing: -20, duration: 1000 });
      } else if (mode === 'freeflight') {
        map.easeTo({ pitch: 75, bearing: map.getBearing(), duration: 1000 });
      }
    },
  });

  // ── Fetch weather data in background ───────────────────────────────
  weather.loadInitial().catch(e => console.warn('[Weather] load failed:', e));

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        break;
      case 'KeyR':
        map.flyTo({ center: [0, 20], zoom: 1.8, pitch: 52, bearing: -20, duration: 1500 });
        break;
      case 'Digit1':
        document.getElementById('btn-wind')?.click();
        break;
      case 'Digit2':
        document.getElementById('btn-radar')?.click();
        break;
      case 'Digit3':
        document.getElementById('btn-temp')?.click();
        break;
      case 'Digit4':
        document.getElementById('btn-pressure')?.click();
        break;
      case 'Digit5':
        document.getElementById('btn-humidity')?.click();
        break;
      case 'Equal':
      case 'NumpadAdd':
        map.zoomIn();
        break;
      case 'Minus':
      case 'NumpadSubtract':
        map.zoomOut();
        break;
    }
  });
}

init().catch(console.error);
