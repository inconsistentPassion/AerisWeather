/**
 * Coordinate utilities — Lat/lon ↔ Cartesian conversions for the globe.
 */

import { GLOBE_RADIUS } from '../scene/Globe';

/**
 * Convert lat/lon (radians) + radius to Cartesian position.
 */
export function latLonToCartesian(lat: number, lon: number, radius: number = GLOBE_RADIUS): [number, number, number] {
  const x = radius * Math.cos(lat) * Math.cos(lon);
  const y = radius * Math.sin(lat);
  const z = radius * Math.cos(lat) * Math.sin(lon);
  return [x, y, z];
}

/**
 * Convert Cartesian position to lat/lon (radians) + radius.
 */
export function cartesianToLatLon(x: number, y: number, z: number): { lat: number; lon: number; radius: number } {
  const radius = Math.sqrt(x * x + y * y + z * z);
  const lat = Math.asin(y / radius);
  const lon = Math.atan2(z, x);
  return { lat, lon, radius };
}

/**
 * Convert degrees to radians.
 */
export function degToRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Convert radians to degrees.
 */
export function radToDeg(rad: number): number {
  return rad * (180 / Math.PI);
}

/**
 * Convert lat/lon (degrees) to grid indices.
 */
export function latLonToGridIndex(
  lat: number,
  lon: number,
  gridWidth: number,
  gridHeight: number
): { i: number; j: number } {
  const i = Math.floor(((lon + 180) / 360) * gridWidth) % gridWidth;
  const j = Math.floor(((90 - lat) / 180) * gridHeight);
  return { i, j };
}
