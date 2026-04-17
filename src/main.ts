/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 *
 * Architecture:
 *   MapLibre GL JS  → globe, tiles, zoom, camera, atmosphere (built-in)
 *   Three.js        → volumetric clouds (custom layer, shared GL context)
 *   WeatherManager  → data pipeline (shared between both)
 */

import { createMapGlobe } from './scene/MapGlobe';
import { createUI } from './ui/UI';

async function init() {
  const container = document.getElementById('app')!;
  const uiContainer = document.getElementById('ui-overlay')!;

  // ── MapLibre globe + Three.js cloud overlay ────────────────────────
  const globe = createMapGlobe(container);
  const { map, weather } = globe;

  // ── Wait for map to load ───────────────────────────────────────────
  await globe.ready;

  // ── Load weather data ──────────────────────────────────────────────
  await weather.loadInitial();

  // ── UI ─────────────────────────────────────────────────────────────
  const ui = createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => {
      weather.toggleLayer(layer, active);

      // Toggle cloud layer visibility in MapLibre
      if (layer === 'clouds') {
        try {
          if (active) {
            map.setLayoutProperty('three-clouds', 'visibility', 'visible');
          } else {
            map.setLayoutProperty('three-clouds', 'visibility', 'none');
          }
        } catch { /* layer may not exist yet */ }
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

  // Stop auto-rotate on user interaction
  map.on('mousedown', () => { autoRotate = false; });
  map.on('touchstart', () => { autoRotate = false; });
}

init().catch(console.error);
