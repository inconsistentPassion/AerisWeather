/**
 * WindParticleLayer — deck.gl LineLayer-based wind field visualization.
 */

import { LineLayer } from '@deck.gl/layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { WeatherManager } from '../weather/WeatherManager';
import type { DeckLayerManager } from '../clouds/DeckLayerManager';

const TOTAL_PARTICLES = 40000;
const MAX_DRAWN = 15000;
const TRAIL_LEN = 5;
const MAX_AGE = 100;
const BASE_SPEED = 0.004;
const UPDATE_INTERVAL = 16;

const SPEED_COLORS: [number, number, number][] = [
  [30, 100, 220],
  [55, 180, 210],
  [80, 240, 195],
  [140, 255, 120],
  [210, 230, 55],
  [255, 180, 30],
  [255, 100, 15],
  [255, 30, 10],
];

interface WindSegment {
  sourcePosition: [number, number, number];
  targetPosition: [number, number, number];
  color: [number, number, number, number];
  width: number;
}

export class WindParticleLayer {
  private map: MapLibreMap;
  private weather: WeatherManager;
  private manager: DeckLayerManager;
  private visible = false;
  private animId: number | null = null;
  private lastUpdate = 0;

  private lon = new Float64Array(TOTAL_PARTICLES);
  private lat = new Float64Array(TOTAL_PARTICLES);
  private age = new Float64Array(TOTAL_PARTICLES);
  private trailLon = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailLat = new Float64Array(TOTAL_PARTICLES * TRAIL_LEN);
  private trailHead = new Uint16Array(TOTAL_PARTICLES);
  private segments: WindSegment[] = [];

  constructor(map: MapLibreMap, weather: WeatherManager, manager: DeckLayerManager) {
    this.map = map;
    this.weather = weather;
    this.manager = manager;
    for (let i = 0; i < TOTAL_PARTICLES; i++) this.spawn(i);
  }

  private spawn(i: number): void {
    this.lon[i] = (Math.random() - 0.5) * 360;
    this.lat[i] = (Math.random() - 0.5) * 180;
    this.age[i] = Math.random() * MAX_AGE * 0.3;
    this.trailHead[i] = 0;
    const b = i * TRAIL_LEN;
    for (let t = 0; t < TRAIL_LEN; t++) {
      this.trailLon[b + t] = this.lon[i];
      this.trailLat[b + t] = this.lat[i];
    }
  }

  private sampleWind(u: Float32Array, v: Float32Array, lon: number, lat: number) {
    const gw = 360, gh = 180;
    const normLon = ((lon + 180) % 360 + 360) % 360;
    const x = (normLon / 360) * gw;
    const y = ((90 - lat) / 180) * gh;
    const x0 = Math.floor(x) % gw;
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)));
    const x1 = (x0 + 1) % gw;
    const y1 = Math.min(gh - 1, y0 + 1);
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const bl = (v00: number, v01: number, v10: number, v11: number) =>
      v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
    const uVal = bl(u[y0 * gw + x0], u[y0 * gw + x1], u[y1 * gw + x0], u[y1 * gw + x1]);
    const vVal = bl(v[y0 * gw + x0], v[y0 * gw + x1], v[y1 * gw + x0], v[y1 * gw + x1]);
    return { u: uVal, v: vVal, speed: Math.sqrt(uVal * uVal + vVal * vVal) };
  }

  private isFrontSide(lon: number, lat: number): boolean {
    const c = this.map.getCenter();
    const cLat = c.lat * Math.PI / 180;
    const cLon = c.lng * Math.PI / 180;
    const pLat = lat * Math.PI / 180;
    const pLon = lon * Math.PI / 180;
    return Math.sin(cLat) * Math.sin(pLat) +
           Math.cos(cLat) * Math.cos(pLat) * Math.cos(pLon - cLon) > 0.05;
  }

  private frame(): void {
    if (!this.visible || !this.weather.isLayerActive('wind')) {
      if (this.segments.length > 0) {
        this.segments = [];
        this.manager.removeLayer('wind-segments');
      }
      this.animId = requestAnimationFrame(() => this.frame());
      return;
    }

    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_INTERVAL) {
      this.animId = requestAnimationFrame(() => this.frame());
      return;
    }
    this.lastUpdate = now;

    const wf = this.weather.getWindField('surface');
    if (!wf) {
      this.animId = requestAnimationFrame(() => this.frame());
      return;
    }

    const { u, v } = wf;
    const bounds = this.map.getBounds();
    const vpW = bounds.getWest(), vpE = bounds.getEast();
    const vpS = bounds.getSouth(), vpN = bounds.getNorth();
    const crossesDateLine = vpW > vpE;

    this.segments = [];
    let drawn = 0;

    for (let i = 0; i < TOTAL_PARTICLES && drawn < MAX_DRAWN; i++) {
      this.age[i] += 1;
      if (this.age[i] >= MAX_AGE) { this.spawn(i); continue; }

      const wind = this.sampleWind(u, v, this.lon[i], this.lat[i]);

      if (wind.speed >= 0.3) {
        const cosLat = Math.max(0.3, Math.cos(this.lat[i] * Math.PI / 180));
        const sf = Math.sqrt(wind.speed);
        this.lon[i] += (wind.u / wind.speed) * sf * BASE_SPEED / cosLat;
        this.lat[i] += (wind.v / wind.speed) * sf * BASE_SPEED;
        if (this.lon[i] > 180) this.lon[i] -= 360;
        if (this.lon[i] < -180) this.lon[i] += 360;
        this.lat[i] = Math.max(-85, Math.min(85, this.lat[i]));
      }

      const h = this.trailHead[i];
      const tb = i * TRAIL_LEN;
      this.trailLon[tb + h] = this.lon[i];
      this.trailLat[tb + h] = this.lat[i];
      this.trailHead[i] = (h + 1) % TRAIL_LEN;

      if (wind.speed < 0.3 || this.age[i] < TRAIL_LEN) continue;

      let inView: boolean;
      if (crossesDateLine) {
        inView = (this.lon[i] >= vpW - 2) || (this.lon[i] <= vpE + 2);
      } else {
        inView = this.lon[i] >= vpW - 2 && this.lon[i] <= vpE + 2;
      }
      if (!inView || this.lat[i] < vpS - 2 || this.lat[i] > vpN + 2) continue;
      if (!this.isFrontSide(this.lon[i], this.lat[i])) continue;

      const bin = Math.min(SPEED_COLORS.length - 1, Math.floor((wind.speed / 25) * SPEED_COLORS.length));
      const [r, g, b] = SPEED_COLORS[bin];
      const alpha = 160 + bin * 12;

      for (let t = 0; t < TRAIL_LEN - 1; t++) {
        const s0 = (h + t) % TRAIL_LEN;
        const s1 = (h + t + 1) % TRAIL_LEN;
        const slon0 = this.trailLon[tb + s0], slat0 = this.trailLat[tb + s0];
        const slon1 = this.trailLon[tb + s1], slat1 = this.trailLat[tb + s1];
        if (Math.abs(slon1 - slon0) > 10) continue;

        this.segments.push({
          sourcePosition: [slon0, slat0, 0],
          targetPosition: [slon1, slat1, 0],
          color: [r, g, b, alpha],
          width: 0.8 + bin * 0.15,
        });
      }
      drawn++;
    }

    if (this.segments.length > 0) {
      this.manager.setLayer('wind-segments', new LineLayer<WindSegment>({
        id: 'wind-segments',
        data: this.segments,
        getSourcePosition: d => d.sourcePosition,
        getTargetPosition: d => d.targetPosition,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthUnits: 'pixels',
        pickable: false,
      }));
    } else {
      this.manager.removeLayer('wind-segments');
    }

    this.animId = requestAnimationFrame(() => this.frame());
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v && this.animId === null) {
      this.lastUpdate = 0;
      this.frame();
    } else if (!v && this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
      this.segments = [];
      this.manager.removeLayer('wind-segments');
    }
  }

  destroy(): void {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
    this.manager.removeLayer('wind-segments');
  }
}
