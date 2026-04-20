/**
 * Weather type definitions.
 */

export type WeatherLevel = 'surface' | '925hPa' | '850hPa' | '700hPa' | '500hPa' | 'FL100' | 'FL200' | 'FL300' | 'FL450';

export type WeatherLayer = 'wind' | 'temperature' | 'pressure' | 'humidity' | 'radar' | 'satellite' | 'clouds';

export interface WeatherGrid {
  width: number;
  height: number;
  fields: {
    cloudFraction?: Float32Array;
    temperature?: Float32Array;
    pressure?: Float32Array;
    humidity?: Float32Array;
    u?: Float32Array;        // wind east-west component (m/s)
    v?: Float32Array;        // wind north-south component (m/s)
    w?: Float32Array;        // wind vertical component (m/s)
  };
}

/**
 * 3-layer cloud data (low/mid/high) from GFS or procedural fallback.
 *
 * Altitude mapping (approximate):
 *   Low:    surface → ~700 hPa  (~0–3 km)
 *   Medium: ~700 → ~400 hPa     (~3–7 km)
 *   High:   above ~400 hPa      (~7–13 km)
 */
export interface CloudLayers {
  width: number;
  height: number;
  low: Float32Array;      // LCDC: Low Cloud Cover (0-1)
  medium: Float32Array;   // MCDC: Medium Cloud Cover (0-1)
  high: Float32Array;     // HCDC: High Cloud Cover (0-1)
  windU: Float32Array;    // U wind component (m/s)
  windV: Float32Array;    // V wind component (m/s)
  source?: string;        // 'GFS' | 'procedural'
}

export interface TimeRange {
  start: number;
  end: number;
  stepMs: number;
}

export interface CloudConfig {
  baseAltitude: number;
  topAltitude: number;
  coverage: number;
  density: number;
}

export interface WeatherTile {
  level: WeatherLevel;
  time: number;
  grid: WeatherGrid;
}
