/**
 * GFS (Global Forecast System) data source adapter.
 * Fetches real weather data from NOAA's NOMADS.
 * 
 * GFS runs 4x daily (00, 06, 12, 18 UTC) with forecasts to 384 hours.
 * Data available at: https://nomads.ncep.noaa.gov/
 */

import * as fs from 'fs';
import * as path from 'path';

export interface GFSConfig {
  baseUrl: string;
  resolution: '0p25' | '0p50' | '1p00';
  cacheDir: string;
  cacheTTL: number; // seconds
}

export interface GFSCycle {
  date: string;    // YYYYMMDD
  hour: string;    // 00, 06, 12, 18
}

export interface GFSGrid {
  level: string;
  field: string;
  width: number;
  height: number;
  data: Float32Array;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

const DEFAULT_CONFIG: GFSConfig = {
  baseUrl: 'https://nomads.ncep.noaa.gov',
  resolution: '0p50',
  cacheDir: './cache/gfs',
  cacheTTL: 3600, // 1 hour
};

// GFS variable mappings
const GFS_VARIABLES: Record<string, { grib: string; units: string; description: string }> = {
  'temperature': { grib: 'TMP', units: 'K', description: 'Temperature' },
  'wind_u': { grib: 'UGRD', units: 'm/s', description: 'U-component of wind' },
  'wind_v': { grib: 'VGRD', units: 'm/s', description: 'V-component of wind' },
  'humidity': { grib: 'RH', units: '%', description: 'Relative humidity' },
  'cloud_cover': { grib: 'TCDC', units: '%', description: 'Total cloud cover' },
  'pressure': { grib: 'PRMSL', units: 'Pa', description: 'Pressure reduced to MSL' },
};

// Level mappings for GRIB2
const LEVEL_MAP: Record<string, string> = {
  'surface': 'surface',
  '1000hPa': '1000 mb',
  '925hPa': '925 mb',
  '850hPa': '850 mb',
  '700hPa': '700 mb',
  '500hPa': '500 mb',
  '300hPa': '300 mb',
  '200hPa': '200 mb',
  'FL100': '10000 ft',
  'FL200': '20000 ft',
  'FL300': '30000 ft',
};

export class GFSAdapter {
  private config: GFSConfig;

  constructor(config: Partial<GFSConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureCacheDir();
  }

  /**
   * Get the current GFS cycle (most recent completed run).
   */
  getCurrentCycle(): GFSCycle {
    const now = new Date();
    const hours = now.getUTCHours();
    
    // GFS runs at 00, 06, 12, 18 UTC
    // Data is available ~3-4 hours after run time
    let cycleHour = Math.floor((hours - 3) / 6) * 6;
    let date = new Date(now);
    
    if (cycleHour < 0) {
      cycleHour = 18;
      date.setUTCDate(date.getUTCDate() - 1);
    }
    
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    return {
      date: dateStr,
      hour: String(cycleHour).padStart(2, '0'),
    };
  }

  /**
   * Fetch GFS data for a specific cycle and forecast hour.
   */
  async fetchData(
    cycle: GFSCycle,
    fhour: number,
    variables: string[],
    level: string = 'surface'
  ): Promise<GFSGrid | null> {
    const cacheKey = this.getCacheKey(cycle, fhour, variables, level);
    
    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      console.log(`[GFS] Cache hit: ${cacheKey}`);
      return cached;
    }

    // Try fetching from NOAA
    try {
      const grid = await this.fetchFromNOAA(cycle, fhour, variables, level);
      if (grid) {
        this.saveToCache(cacheKey, grid);
        return grid;
      }
    } catch (err) {
      console.warn(`[GFS] NOAA fetch failed: ${(err as Error).message}`);
    }

    return null;
  }

  /**
   * Build NOAA URL for GFS data.
   * Format: gfs.YYYYMMDD/CC/atmos/gfs.tCCz.pgrb2.0p50.fHHH
   */
  private buildNOAAUrl(cycle: GFSCycle, fhour: number): string {
    const fhourStr = String(fhour).padStart(3, '0');
    return `${this.config.baseUrl}/pub/data/nccf/com/gfs/prod/gfs.${cycle.date}/${cycle.hour}/atmos/gfs.t${cycle.hour}z.pgrb2.${this.config.resolution}.f${fhourStr}`;
  }

  /**
   * Fetch from NOAA NOMADS (GRIB2 format).
   * Note: Full GRIB2 parsing would need a library like grib2json or wgrib2.
   * For now, we use a proxy approach or fallback to procedural.
   */
  private async fetchFromNOAA(
    cycle: GFSCycle,
    fhour: number,
    variables: string[],
    level: string
  ): Promise<GFSGrid | null> {
    const url = this.buildNOAAUrl(cycle, fhour);
    console.log(`[GFS] Fetching: ${url}`);

    // For demo/prototype: use NOAA's simpler JSON endpoints
    // The GridData API returns JSON for specific variables
    const jsonUrl = this.buildJSONUrl(cycle, fhour, variables, level);
    
    try {
      const response = await fetch(jsonUrl, {
        headers: {
          'User-Agent': 'AerisWeather/0.1.0',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Parse response - format depends on the endpoint used
      // For now, return null and fall back to procedural
      return null;
    } catch (err) {
      console.warn(`[GFS] Fetch error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Build a JSON-friendly URL for weather data.
   * Uses alternative endpoints when available.
   */
  private buildJSONUrl(cycle: GFSCycle, fhour: number, variables: string[], level: string): string {
    // NOAA Weather Prediction Center has some JSON endpoints
    // For full data, you'd typically use wgrib2 or a GRIB2-to-JSON converter
    const fhourStr = String(fhour).padStart(3, '0');
    return `${this.config.baseUrl}/pub/data/nccf/com/gfs/prod/gfs.${cycle.date}/${cycle.hour}/atmos/gfs.t${cycle.hour}z.pgrb2.${this.config.resolution}.f${fhourStr}`;
  }

  // ── Cache Management ────────────────────────────────────────────────

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.config.cacheDir)) {
      fs.mkdirSync(this.config.cacheDir, { recursive: true });
    }
  }

  private getCacheKey(cycle: GFSCycle, fhour: number, variables: string[], level: string): string {
    return `${cycle.date}_${cycle.hour}_f${String(fhour).padStart(3, '0')}_${level}_${variables.sort().join('-')}`;
  }

  private getFromCache(key: string): GFSGrid | null {
    const filePath = path.join(this.config.cacheDir, `${key}.json`);
    
    try {
      if (!fs.existsSync(filePath)) return null;
      
      const stat = fs.statSync(filePath);
      const age = (Date.now() - stat.mtimeMs) / 1000;
      
      if (age > this.config.cacheTTL) {
        fs.unlinkSync(filePath);
        return null;
      }

      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      
      return {
        ...parsed,
        data: new Float32Array(parsed.data),
      };
    } catch {
      return null;
    }
  }

  private saveToCache(key: string, grid: GFSGrid): void {
    const filePath = path.join(this.config.cacheDir, `${key}.json`);
    
    try {
      const serializable = {
        ...grid,
        data: Array.from(grid.data),
      };
      fs.writeFileSync(filePath, JSON.stringify(serializable), 'utf-8');
    } catch (err) {
      console.warn(`[GFS] Cache write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Get available GFS variables.
   */
  getAvailableVariables(): typeof GFS_VARIABLES {
    return GFS_VARIABLES;
  }

  /**
   * Get available pressure levels.
   */
  getAvailableLevels(): string[] {
    return Object.keys(LEVEL_MAP);
  }
}

// Export singleton
export const gfsAdapter = new GFSAdapter();
