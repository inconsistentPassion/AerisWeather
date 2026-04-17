/**
 * Weather type definitions.
 */

export type WeatherLevel = 'surface' | '925hPa' | '850hPa' | '700hPa' | '500hPa' | 'FL100' | 'FL200' | 'FL300' | 'FL450';

export type WeatherLayer = 'wind' | 'temperature' | 'pressure' | 'humidity' | 'clouds' | 'radar' | 'satellite';

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

export interface TimeRange {
  start: number;   // Unix timestamp
  end: number;
  stepMs: number;  // Time step between forecasts
}

export interface CloudConfig {
  baseAltitude: number;   // km above surface
  topAltitude: number;    // km above surface
  coverage: number;       // 0-1 global coverage scalar
  density: number;        // 0-1 density multiplier
}

export interface WeatherTile {
  level: WeatherLevel;
  time: number;
  grid: WeatherGrid;
}

export interface DataTexturePayload {
  data: Float32Array;
  width: number;
  height: number;
  channels: number;
}
