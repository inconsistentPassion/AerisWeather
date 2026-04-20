/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 *
 * MapLibre (flat mercator) + deck.gl overlay.
 * Clouds: volumetric noise-texture particles when zoomed into a city.
 * Wind: global particle trails. Rain: radar-based scatter.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';
import { createUI } from './ui/UI';
import { WeatherManager } from './weather/WeatherManager';
import { DeckLayers } from './weather/DeckLayers';
import { CloudPointLayer } from './clouds/CloudPointLayer';
import { RainEffect } from './clouds/RainEffect';
import { CITIES, searchCities, City } from './weather/CitySearch';

// Dark raster style — no CORS issues (unlike Carto vector tiles)
const STYLE_URL: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Dark',
  sources: {
    'raster-tiles': {
      type: 'raster',
      tiles: [
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#0a0e18' },
    },
    {
      id: 'osm-tiles',
      type: 'raster',
      source: 'raster-tiles',
      paint: {
        'raster-saturation': -0.9,
        'raster-brightness-min': 0.04,
        'raster-brightness-max': 0.25,
        'raster-contrast': 0.4,
        'raster-opacity': 0.7,
      },
    },
  ],
};

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

  // ── MapLibre custom WebGL layers (data-driven clouds + rain) ──────
  const cloudLayer = new CloudPointLayer(weather);
  map.addLayer(cloudLayer.getLayer());

  const rainEffect = new RainEffect(map);
  map.addLayer(rainEffect.getLayer());
  rainEffect.setVisible(true);

  let currentCity: City | null = null;

  // ── UI ─────────────────────────────────────────────────────────────
  createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => {
      weather.toggleLayer(layer, active);
      deckLayers.setVisible(layer as any, active);
      if (layer === 'clouds') cloudLayer.setVisible(active);
      if (layer === 'radar') rainEffect.setVisible(active);
    },
    onCameraMode: (mode) => {
      if (mode === 'orbit') map.flyTo({ pitch: 0, bearing: 0, duration: 1000 });
      else if (mode === 'freeflight') map.flyTo({ pitch: 45, bearing: map.getBearing(), duration: 1000 });
    },
  });

  // ── City search UI ─────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'city-panel';
  panel.innerHTML = `
    <div class="city-search-row">
      <span class="city-icon">🔍</span>
      <input id="city-input" class="city-input" type="text" placeholder="Search city…" autocomplete="off" />
    </div>
    <div id="city-results" class="city-results"></div>
    <div id="city-info" class="city-info" style="display:none;"></div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    .city-panel {
      position: absolute;
      top: 60px;
      right: 20px;
      z-index: 20;
      background: rgba(12, 18, 35, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(100, 140, 200, 0.15);
      border-radius: 12px;
      padding: 10px 12px;
      width: 240px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
    }
    .city-search-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .city-icon { font-size: 14px; opacity: 0.6; }
    .city-input {
      flex: 1;
      background: rgba(30, 45, 75, 0.6);
      border: 1px solid rgba(60, 90, 140, 0.2);
      border-radius: 8px;
      color: #c8d6e5;
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    .city-input:focus {
      border-color: rgba(80, 140, 240, 0.5);
      box-shadow: 0 0 8px rgba(60, 140, 255, 0.15);
    }
    .city-input::placeholder { color: #4a5568; }
    .city-results {
      max-height: 280px;
      overflow-y: auto;
      margin-top: 6px;
    }
    .city-results:empty { display: none; }
    .city-result {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
      font-size: 12px;
      color: #a0b8d0;
    }
    .city-result:hover {
      background: rgba(55, 110, 190, 0.25);
      color: #fff;
    }
    .city-result-name {
      font-weight: 600;
      color: #c8d6e5;
    }
    .city-result:hover .city-result-name { color: #fff; }
    .city-result-country {
      color: #5a6b7d;
      font-size: 11px;
      margin-left: auto;
    }
    .city-result-coords {
      color: #3a4858;
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .city-info {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(100, 140, 200, 0.1);
      font-size: 11px;
      color: #6b7b8d;
      line-height: 1.6;
    }
    .city-info-active {
      color: #4a9eff;
    }
    .city-global-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      color: #6b7b8d;
      transition: background 0.1s;
      border-bottom: 1px solid rgba(100, 140, 200, 0.08);
      margin-bottom: 4px;
    }
    .city-global-btn:hover {
      background: rgba(55, 110, 190, 0.2);
      color: #a0b8d0;
    }
  `;
  document.head.appendChild(style);
  uiContainer.appendChild(panel);

  const cityInput = panel.querySelector('#city-input') as HTMLInputElement;
  const cityResults = panel.querySelector('#city-results') as HTMLElement;
  const cityInfo = panel.querySelector('#city-info') as HTMLElement;

  function selectCity(city: City | null) {
    currentCity = city;
    cityInput.value = city ? city.name : '';
    cityResults.innerHTML = '';
    cityInput.blur();

    if (!city) {
      cityInfo.style.display = 'none';
      deckLayers.focusCity(null);
      map.flyTo({ center: [0, 20], zoom: 2, pitch: 0, duration: 1500 });
      return;
    }

    map.flyTo({
      center: [city.lon, city.lat],
      zoom: 10,
      pitch: 45,
      duration: 2000,
    });

    deckLayers.focusCity(city);

    cityInfo.style.display = 'block';
    cityInfo.className = 'city-info city-info-active';
    cityInfo.textContent = `☁️ ${city.name} — generating volumetric clouds…`;

    setTimeout(() => {
      cityInfo.textContent = `☁️ ${city.name} — volumetric clouds active`;
    }, 2000);
  }

  function renderResults(results: City[]) {
    cityResults.innerHTML = '';

    if (cityInput.value.trim()) {
      // Global view button
      const globalBtn = document.createElement('div');
      globalBtn.className = 'city-global-btn';
      globalBtn.innerHTML = '🌍 <span>Global View</span>';
      globalBtn.addEventListener('click', () => selectCity(null));
      cityResults.appendChild(globalBtn);
    }

    for (const city of results) {
      const el = document.createElement('div');
      el.className = 'city-result';
      el.innerHTML = `
        <span class="city-result-name">${city.name}</span>
        <span class="city-result-coords">${city.lat.toFixed(1)}° ${city.lon.toFixed(1)}°</span>
        <span class="city-result-country">${city.country}</span>
      `;
      el.addEventListener('click', () => selectCity(city));
      cityResults.appendChild(el);
    }
  }

  // Search on input
  let searchTimeout: ReturnType<typeof setTimeout>;
  cityInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const q = cityInput.value.trim();
      if (!q) {
        cityResults.innerHTML = '';
        return;
      }
      const results = searchCities(q, 8);
      renderResults(results);
    }, 80); // 80ms debounce
  });

  // Show all popular cities on focus if empty
  cityInput.addEventListener('focus', () => {
    if (!cityInput.value.trim()) {
      renderResults(CITIES.slice(0, 8));
    }
  });

  // Close results on click outside
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target as HTMLElement)) {
      cityResults.innerHTML = '';
    }
  });

  // Keyboard: Enter to select first result, Escape to close
  cityInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const firstResult = cityResults.querySelector('.city-result');
      if (firstResult) firstResult.dispatchEvent(new Event('click'));
      e.preventDefault();
    } else if (e.key === 'Escape') {
      cityResults.innerHTML = '';
      cityInput.blur();
    }
  });

  // ── Load weather ───────────────────────────────────────────────────
  weather.loadInitial().catch(e => console.warn('[Weather] load failed:', e));

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    // Don't trigger when typing in search
    if (document.activeElement === cityInput) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); break;
      case 'KeyR': selectCity(null); break;
      case 'Equal': case 'NumpadAdd': map.zoomIn(); break;
      case 'Minus': case 'NumpadSubtract': map.zoomOut(); break;
    }
  });
}

init().catch(console.error);
