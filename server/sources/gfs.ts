/**
 * GFS (Global Forecast System) data source adapter.
 * Fetches from NOAA's GFS open data.
 */

// GFS data is available at:
// https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/

export interface GFSConfig {
  baseUrl: string;
  resolution: '0p25' | '0p50' | '1p00';
}

const DEFAULT_CONFIG: GFSConfig = {
  baseUrl: 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod',
  resolution: '0p50',
};

/**
 * Fetch GFS data for a given cycle and forecast hour.
 *
 * GFS runs 4x daily (00, 06, 12, 18 UTC) and produces forecasts out to 384 hours.
 *
 * @param cycle - GFS cycle time (e.g., '20240115/00')
 * @param fhour - Forecast hour (e.g., '003' for +3h)
 * @param fields - Variables to extract (e.g., ['TMP', 'UGRD', 'VGRD', 'RH', 'TCDC'])
 */
export async function fetchGFSData(
  cycle: string,
  fhour: string,
  fields: string[]
): Promise<Buffer | null> {
  const config = DEFAULT_CONFIG;

  // GFS grib2 file URL pattern:
  // gfs.YYYYMMDD/CC/atmos/gfs.tCCz.pgrb2.0p25.fHHH
  const url = `${config.baseUrl}/gfs.${cycle}/atmos/gfs.t${cycle.split('/')[1]}z.pgrb2.${config.resolution}.f${fhour}`;

  // TODO: Implement actual fetch with caching
  // For now, return null (placeholder)
  console.log(`[GFS] Would fetch: ${url}`);
  console.log(`[GFS] Fields: ${fields.join(', ')}`);

  return null;
}

/**
 * Extract a specific variable from GRIB2 data.
 *
 * Common GFS variables:
 *  - TMP: Temperature (K)
 *  - UGRD: U-component of wind (m/s)
 *  - VGRD: V-component of wind (m/s)
 *  - RH: Relative humidity (%)
 *  - TCDC: Total cloud cover (%)
 *  - PRMSL: Pressure reduced to MSL (Pa)
 *  - HGT: Geopotential height (gpm)
 *  - VVEL: Vertical velocity (Pa/s)
 */
export function extractVariable(_gribData: Buffer, _variable: string): Float32Array | null {
  // TODO: Parse GRIB2 and extract variable
  // Would use a GRIB2 parser library or call wgrib2 externally
  return null;
}
