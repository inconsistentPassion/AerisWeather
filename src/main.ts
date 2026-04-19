/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 *
 * MapLibre GL JS  → globe, tiles, zoom, camera, atmosphere
 * Custom layers   → wind particles, cloud overlay
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { createUI } from './ui/UI';
import { WeatherManager } from './weather/WeatherManager';
import { WindParticleLayer } from './weather/WindParticleLayer';
import { RadarLayer } from './clouds/RadarLayer';
import { RainEffect } from './clouds/RainEffect';

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
    transformRequest: (url, resourceType) => {
      // Cap RainViewer tile requests at z10 — force parent tile at max zoom
      // so MapLibre upscales instead of requesting non-existent tiles
      if (resourceType === 'Tile' && url.includes('rainviewer.com')) {
        const match = url.match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
        if (match) {
          const z = parseInt(match[1]);
          const x = parseInt(match[2]);
          const y = parseInt(match[3]);
          if (z > 10) {
            const scale = 1 << (z - 10);
            const cx = Math.floor(x / scale);
            const cy = Math.floor(y / scale);
            const capped = url.replace(`/${z}/${x}/${y}.png`, `/10/${cx}/${cy}.png`);
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

  map.on('error', (e) => console.error('MapLibre error:', e));

  // ── Wait for map ───────────────────────────────────────────────────
  await new Promise<void>((resolve) => map.on('load', () => resolve()));

  // ── Atmosphere + Sky (globe glow) ──────────────────────────────
  try {
    (map as any).setSky({
      'sky-type': 'atmosphere',
      'sky-atmosphere-sun': [0.0, 0.0],
      'sky-atmosphere-sun-intensity': 15,
    });
    console.log('[Sky] Atmosphere glow enabled');
  } catch (e) {
    console.warn('[Sky] Failed:', e);
  }

  // ── 3D Terrain elevation ────────────────────────────────────────
  try {
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
    });
    map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
    console.log('[Terrain] 3D elevation enabled');
  } catch (e) {
    console.warn('[Terrain] Failed to load:', e);
  }

  // ── Suppress RainViewer zoom errors ─────────────────────────────
  map.on('error', (e) => {
    const msg = e.error?.message || e.error?.toString() || '';
    if (msg.includes('rainviewer') || msg.includes('zoom level')) {
      return; // silently ignore — we handle zoom capping via transformRequest
    }
    console.error('MapLibre error:', e);
  });

  // ── Add weather layers immediately ──────────────────────────────
  const windParticles = new WindParticleLayer(map, weather);
  const radarLayer = new RadarLayer(map, weather);
  const rainEffect = new RainEffect(map, weather);

  // Start radar + rain on init (they're on by default)
  radarLayer.setVisible(true);
  rainEffect.setVisible(true);

  // ── UI immediately ─────────────────────────────────────────────
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

  // ── Fetch weather data in background (non-blocking) ────────────
  weather.loadInitial().catch(e => console.warn('[Weather] load failed:', e));

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  let autoRotate = true; // start with auto-rotate ON

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        autoRotate = !autoRotate;
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

  // ── Auto-rotation (smooth, slows on interaction) ───────────────────
  let rotationSpeed = 0.08;

  function autoRotateTick() {
    if (autoRotate) {
      map.setBearing(map.getBearing() + rotationSpeed);
    }
    requestAnimationFrame(autoRotateTick);
  }
  autoRotateTick();

  // Pause rotation on interaction, resume after 3s of inactivity
  let interactionTimer: ReturnType<typeof setTimeout> | null = null;
  const pauseRotation = () => {
    autoRotate = false;
    if (interactionTimer) clearTimeout(interactionTimer);
    interactionTimer = setTimeout(() => { autoRotate = true; }, 3000);
  };
  map.on('mousedown', pauseRotation);
  map.on('touchstart', pauseRotation);
  map.on('wheel', pauseRotation);
  map.on('dragstart', pauseRotation);
}

init().catch(console.error);
