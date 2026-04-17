/**
 * WindLayer — MapLibre native wind arrows from WeatherManager data.
 *
 * Converts the u/v wind grid into GeoJSON arrow features and renders
 * them as a styled line layer on the MapLibre globe.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const SOURCE_ID = 'wind-arrows';
const LAYER_ID = 'wind-arrows-lines';

// Grid spacing in degrees (lower = more arrows)
const GRID_STEP = 8;

// Arrow length in degrees (visual only)
const ARROW_LEN = 2.5;

export function addWindLayer(map: maplibregl.Map, weather: WeatherManager) {
  // Create empty source
  map.addSource(SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Line layer — arrows as short line segments
  map.addLayer({
    id: LAYER_ID,
    type: 'line',
    source: SOURCE_ID,
    paint: {
      'line-color': ['get', 'color'],
      'line-width': [
        'interpolate', ['linear'], ['zoom'],
        1, 0.8,
        4, 1.5,
        8, 2.5,
      ],
      'line-opacity': 0.7,
      'line-blur': 0.3,
    },
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
    },
  });

  // Initial update
  updateWindArrows(map, weather);

  // Update on weather data changes
  weather.on('dataLoaded', () => updateWindArrows(map, weather));
  weather.on('levelChange', () => updateWindArrows(map, weather));
}

export function updateWindArrows(map: maplibregl.Map, weather: WeatherManager) {
  const windField = weather.getWindField('surface');
  if (!windField) return;

  const { u, v } = windField;
  const gridW = 360;
  const gridH = 180;

  const features: GeoJSON.Feature[] = [];

  for (let j = 0; j < gridH; j += GRID_STEP) {
    for (let i = 0; i < gridW; i += GRID_STEP) {
      const idx = j * gridW + i;
      const windU = u[idx] || 0;
      const windV = v[idx] || 0;
      const speed = Math.sqrt(windU * windU + windV * windV);

      // Skip very calm areas
      if (speed < 0.5) continue;

      // Grid cell center → lon/lat
      const lon = (i / gridW) * 360 - 180 + GRID_STEP / 2;
      const lat = 90 - (j / gridH) * 180 - GRID_STEP / 2;

      // Wind direction in degrees
      const angle = Math.atan2(windU, windV); // meteorological convention

      // Arrow end point
      const lenScale = Math.min(speed / 15, 1) * ARROW_LEN;
      const endLon = lon + Math.sin(angle) * lenScale;
      const endLat = lat + Math.cos(angle) * lenScale;

      // Color by speed: blue (calm) → cyan → yellow → red (strong)
      const speedNorm = Math.min(speed / 25, 1);
      const color = speedToColor(speedNorm);

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [lon, lat],
            [endLon, endLat],
          ],
        },
        properties: {
          speed,
          color,
        },
      });
    }
  }

  const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource;
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features,
    });
  }
}

export function setWindLayerVisible(map: maplibregl.Map, visible: boolean) {
  try {
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  } catch { /* layer may not exist */ }
}

function speedToColor(t: number): string {
  // 0 = blue, 0.33 = cyan, 0.66 = yellow, 1 = red
  let r: number, g: number, b: number;

  if (t < 0.33) {
    const s = t / 0.33;
    r = Math.round(30 + s * 50);
    g = Math.round(100 + s * 155);
    b = Math.round(220 - s * 20);
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    r = Math.round(80 + s * 175);
    g = Math.round(255 - s * 55);
    b = Math.round(200 - s * 180);
  } else {
    const s = (t - 0.66) / 0.34;
    r = Math.round(255);
    g = Math.round(200 - s * 180);
    b = Math.round(20 - s * 20);
  }

  return `rgb(${r},${g},${b})`;
}
