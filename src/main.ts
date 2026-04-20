/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 *
 * MapLibre (flat mercator) + deck.gl overlay.
 * Clouds: volumetric-style particles when zoomed into a city.
 * Wind: global particle trails. Rain: humidity-based scatter.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { createUI } from './ui/UI';
import { WeatherManager } from './weather/WeatherManager';
import { DeckLayers } from './weather/DeckLayers';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

async function init() {
  const container = document.getElementById('app')!;
  const uiContainer = document.getElementById('ui-overlay')!;

  container.style.width = '100%';
  container.style.height = '100%';

  const weather = new WeatherManager();

  // ── MapLibre (flat mercator) ────────────────────────────────────────
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [0, 20],
    zoom: 2,
    pitch: 0,
    bearing: 0,
    maxPitch: 60,
    attributionControl: false,
    renderWorldCopies: true,
    dragRotate: true,
    pitchWithRotate: true,
    touchZoomRotate: true,
  });

  await new Promise<void>((resolve) => map.on('load', () => resolve()));

  map.on('error', (e) => {
    const msg = e.error?.message || '';
    if (msg.includes('404') || msg.includes('not supported')) return;
    console.error('MapLibre error:', e);
  });

  // ── deck.gl layers ─────────────────────────────────────────────────
  const deckLayers = new DeckLayers(weather);
  map.addControl(deckLayers.getControl() as any);
  deckLayers.onMapReady(map);

  // ── City data ──────────────────────────────────────────────────────
  const cities = [
    { name: 'Tokyo', lon: 139.69, lat: 35.68 },
    { name: 'London', lon: -0.12, lat: 51.51 },
    { name: 'New York', lon: -74.01, lat: 40.71 },
    { name: 'Paris', lon: 2.35, lat: 48.86 },
    { name: 'Sydney', lon: 151.21, lat: -33.87 },
    { name: 'Dubai', lon: 55.27, lat: 25.20 },
    { name: 'Singapore', lon: 103.82, lat: 1.35 },
    { name: 'São Paulo', lon: -46.63, lat: -23.55 },
    { name: 'Mumbai', lon: 72.88, lat: 19.08 },
    { name: 'Cairo', lon: 31.24, lat: 30.04 },
    { name: 'Beijing', lon: 116.40, lat: 39.90 },
    { name: 'Moscow', lon: 37.62, lat: 55.76 },
    { name: 'Los Angeles', lon: -118.24, lat: 34.05 },
    { name: 'Berlin', lon: 13.40, lat: 52.52 },
    { name: 'Hong Kong', lon: 114.17, lat: 22.32 },
    { name: 'Seoul', lon: 126.98, lat: 37.57 },
    { name: 'Bangkok', lon: 100.50, lat: 13.76 },
    { name: 'Istanbul', lon: 28.98, lat: 41.01 },
    { name: 'Mexico City', lon: -99.13, lat: 19.43 },
    { name: 'Cape Town', lon: 18.42, lat: -33.92 },
  ];

  let currentCity: typeof cities[0] | null = null;

  // ── UI ─────────────────────────────────────────────────────────────
  createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => {
      weather.toggleLayer(layer, active);
      deckLayers.setVisible(layer as any, active);
    },
    onCameraMode: (mode) => {
      if (mode === 'orbit') map.flyTo({ pitch: 0, bearing: 0, duration: 1000 });
      else if (mode === 'freeflight') map.flyTo({ pitch: 45, bearing: map.getBearing(), duration: 1000 });
    },
  });

  // ── City selector UI ───────────────────────────────────────────────
  const cityPanel = document.createElement('div');
  cityPanel.className = 'city-panel';
  cityPanel.innerHTML = `
    <div class="city-header">
      <span class="city-icon">🏙️</span>
      <select id="city-select" class="city-select">
        <option value="">🌍 Global View</option>
        ${cities.map((c, i) => `<option value="${i}">${c.name}</option>`).join('')}
      </select>
    </div>
    <div id="city-info" class="city-info" style="display:none;"></div>
  `;

  const cityStyle = document.createElement('style');
  cityStyle.textContent = `
    .city-panel {
      position: absolute;
      top: 60px;
      right: 20px;
      z-index: 20;
      background: rgba(12, 18, 35, 0.9);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(100, 140, 200, 0.15);
      border-radius: 12px;
      padding: 12px 16px;
      min-width: 180px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .city-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .city-icon { font-size: 18px; }
    .city-select {
      background: rgba(30, 45, 75, 0.6);
      border: 1px solid rgba(60, 90, 140, 0.2);
      border-radius: 8px;
      color: #c8d6e5;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      outline: none;
      flex: 1;
      min-width: 140px;
    }
    .city-select:hover {
      border-color: rgba(80, 140, 240, 0.35);
    }
    .city-select option {
      background: #0c1223;
      color: #c8d6e5;
    }
    .city-info {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(100, 140, 200, 0.1);
      font-size: 11px;
      color: #6b7b8d;
      line-height: 1.6;
    }
  `;
  document.head.appendChild(cityStyle);
  uiContainer.appendChild(cityPanel);

  const citySelect = cityPanel.querySelector('#city-select') as HTMLSelectElement;
  const cityInfo = cityPanel.querySelector('#city-info') as HTMLElement;

  citySelect.addEventListener('change', () => {
    const idx = citySelect.value;
    if (idx === '') {
      // Global view
      currentCity = null;
      cityInfo.style.display = 'none';
      deckLayers.focusCity(null);
      map.flyTo({ center: [0, 20], zoom: 2, pitch: 0, duration: 1500 });
      return;
    }

    const city = cities[parseInt(idx)];
    currentCity = city;

    // Zoom into city
    map.flyTo({
      center: [city.lon, city.lat],
      zoom: 10,
      pitch: 45,
      duration: 2000,
    });

    // Show volumetric clouds for this city
    deckLayers.focusCity(city);

    cityInfo.style.display = 'block';
    cityInfo.textContent = `${city.name}: ${city.lat.toFixed(2)}°, ${city.lon.toFixed(2)}° — zooming in for volumetric clouds…`;

    // Update info after zoom
    setTimeout(() => {
      cityInfo.textContent = `${city.name}: ${city.lat.toFixed(2)}°, ${city.lon.toFixed(2)}° — volumetric cloud layer active`;
    }, 2500);
  });

  // ── Load weather ───────────────────────────────────────────────────
  weather.loadInitial().catch(e => console.warn('[Weather] load failed:', e));

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Space': e.preventDefault(); break;
      case 'KeyR': map.flyTo({ center: [0, 20], zoom: 2, pitch: 0, bearing: 0, duration: 1500 }); break;
      case 'Equal': case 'NumpadAdd': map.zoomIn(); break;
      case 'Minus': case 'NumpadSubtract': map.zoomOut(); break;
    }
  });
}

init().catch(console.error);
