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
import { CloudLayer } from './clouds/CloudLayer';

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
    zoom: 2.5,
    pitch: 49,
    bearing: -20,
    maxPitch: 80,
    attributionControl: false,
    renderWorldCopies: false,
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

  // ── Add weather layers immediately ──────────────────────────────
  const windParticles = new WindParticleLayer(map, weather);
  const cloudLayer = new CloudLayer(map, weather);

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
        case 'clouds':
          cloudLayer.setVisible(active);
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
  let autoRotate = false;

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        autoRotate = !autoRotate;
        break;
      case 'KeyR':
        map.flyTo({ center: [0, 20], zoom: 2.5, pitch: 49, bearing: -20, duration: 1500 });
        break;
      case 'Digit1':
        document.getElementById('btn-wind')?.click();
        break;
      case 'Digit2':
        document.getElementById('btn-clouds')?.click();
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

  // ── Auto-rotation ──────────────────────────────────────────────────
  function autoRotateTick() {
    if (autoRotate) {
      map.setBearing(map.getBearing() + 0.1);
    }
    requestAnimationFrame(autoRotateTick);
  }
  autoRotateTick();

  map.on('mousedown', () => { autoRotate = false; });
  map.on('touchstart', () => { autoRotate = false; });
}

init().catch(console.error);
