/**
 * WindParticleLayer — Animated wind particles on the MapLibre globe.
 *
 * Uses MapLibre's native circle layer for globe-correct rendering.
 * Particles are advected each frame in JS, then pushed as GeoJSON.
 * Replaces the static wind arrow layer entirely.
 */

import maplibregl from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';

const NUM_PARTICLES = 6000;
const MAX_AGE = 150;
const STEP_PER_MS = 0.0025; // degrees per m/s per frame

const SOURCE_ID = 'wind-particles';
const LAYER_ID  = 'wind-particles-circle';

interface Particle {
  lon: number;
  lat: number;
  age: number;
  speed: number;
}

export class WindParticleLayer {
  private map: maplibregl.Map;
  private weather: WeatherManager;
  private particles: Particle[] = [];
  private animId: number | null = null;
  private frameCount = 0;

  constructor(map: maplibregl.Map, weather: WeatherManager) {
    this.map = map;
    this.weather = weather;
    this.initParticles();
    this.addLayer();
    this.start();
  }

  /* ── setup ──────────────────────────────────────────────────── */

  private initParticles(): void {
    this.particles = [];
    for (let i = 0; i < NUM_PARTICLES; i++) {
      this.particles.push(this.spawn());
    }
  }

  private spawn(): Particle {
    return {
      lon: (Math.random() - 0.5) * 360,
      lat: (Math.random() - 0.5) * 180,
      age: Math.random() * MAX_AGE * 0.4,
      speed: 0,
    };
  }

  private addLayer(): void {
    this.map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    this.map.addLayer({
      id: LAYER_ID,
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['zoom'],
          1, 1.0,
          4, 1.8,
          8, 3.0,
        ],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['get', 'alpha'],
        'circle-blur': 0.5,
      },
    });
  }

  /* ── lifecycle ──────────────────────────────────────────────── */

  start(): void {
    if (this.animId !== null) return;
    const tick = () => {
      this.animId = requestAnimationFrame(tick);
      this.frame();
    };
    this.animId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  setVisible(visible: boolean): void {
    try {
      this.map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
    } catch { /* not yet added */ }
  }

  destroy(): void {
    this.stop();
    try { this.map.removeLayer(LAYER_ID); } catch {}
    try { this.map.removeSource(SOURCE_ID); } catch {}
  }

  /* ── frame ──────────────────────────────────────────────────── */

  private frame(): void {
    if (!this.weather.isLayerActive('wind')) return;

    const wf = this.weather.getWindField('surface');
    if (!wf) return;

    const { u, v } = wf;
    const gridW = 360;
    const gridH = 180;

    const features: GeoJSON.Feature[] = [];

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += 1;

      if (p.age >= MAX_AGE) {
        this.particles[i] = this.spawn();
        continue;
      }

      /* grid sample */
      const gi = Math.min(gridW - 1, Math.max(0, Math.floor(((p.lon + 180) / 360) * gridW)));
      const gj = Math.min(gridH - 1, Math.max(0, Math.floor(((90 - p.lat) / 180) * gridH)));
      const idx = gj * gridW + gi;

      const windU = u[idx] || 0;
      const windV = v[idx] || 0;
      const speed = Math.sqrt(windU * windU + windV * windV);
      p.speed = speed;

      if (speed < 0.5) continue;

      /* advect */
      p.lon += windU * speed * STEP_PER_MS / Math.max(0.3, Math.cos(p.lat * Math.PI / 180));
      p.lat += windV * speed * STEP_PER_MS;

      if (p.lon > 180) p.lon -= 360;
      if (p.lon < -180) p.lon += 360;
      p.lat = Math.max(-85, Math.min(85, p.lat));

      /* age-based alpha */
      const ageAlpha = p.age < 12
        ? p.age / 12
        : p.age > MAX_AGE - 25
          ? (MAX_AGE - p.age) / 25
          : 1;

      const color = speedColor(Math.min(speed / 25, 1));

      features.push({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [p.lon, p.lat],
        },
        properties: {
          speed,
          alpha: ageAlpha * 0.8,
          color: `rgb(${color[0]},${color[1]},${color[2]})`,
        },
      });
    }

    /* push to map */
    try {
      const src = this.map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource;
      if (src) {
        src.setData({ type: 'FeatureCollection', features });
      }
    } catch { /* source not ready */ }
  }
}

/* ── helpers ──────────────────────────────────────────────────── */

function speedColor(t: number): [number, number, number] {
  if (t < 0.33) {
    const s = t / 0.33;
    return [30 + s * 50, 100 + s * 155, 220 - s * 20];
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    return [80 + s * 175, 255 - s * 55, 200 - s * 180];
  }
  const s = (t - 0.66) / 0.34;
  return [255, 200 - s * 180, 20 - s * 20];
}
