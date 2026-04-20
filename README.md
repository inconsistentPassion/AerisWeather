# AerisWeather

**"Windy meets MSFS, but in the browser."**

A real-time 3D weather visualization globe with volumetric clouds, GPU particle wind fields, and multi-level atmospheric data — all rendered in the browser with Three.js/WebGL2.

## Quick Start

```bash
npm install
npm run dev          # Client dev server (Vite)
npm run server       # Weather proxy backend
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser (Three.js)             │
│                                                  │
│  Globe + Atmosphere → Weather Overlays → Clouds  │
│  Camera (Orbit / Free-flight)                    │
│  UI: Time slider, Level selector, Layer toggles  │
│                                                  │
│  Data Manager ← tiles/cache/interpolation        │
└──────────────────┬──────────────────────────────┘
                   │ HTTP / WebSocket
┌──────────────────▼──────────────────────────────┐
│              Backend (Node.js/Express)            │
│                                                  │
│  Weather Proxy → Normalize → Grid → Tile Server  │
│  Sources: GFS (NOAA), OpenWeather, etc.          │
│  Cache: Redis / Disk                             │
└─────────────────────────────────────────────────┘
```

## Core Features

- **3D Globe** — Earth with normal maps, atmosphere scattering shell
- **Volumetric Clouds** — Ray-marched, driven by real weather data (coverage, humidity, altitude shaping)
- **Wind Particles** — GPU-advected particle field (Windy-style streaks)
- **Multi-Level Data** — Surface, 850hPa, 500hPa, FL100–FL300
- **Layer Toggles** — Wind, temp, pressure, clouds, radar, satellite
- **Time Controls** — Scrub forecast timeline
- **Camera Modes** — Orbit + MSFS-style free-flight

## Tech Stack

| Layer    | Tech                                      |
|----------|-------------------------------------------|
| Render   | Three.js (WebGL2), GLSL shaders           |
| Clouds   | Ray-marched volumetric (Perlin-Worley FBM) |
| Wind     | GPU particle advection via transform feedback |
| Data     | GFS/NOAA gridded forecast, NASA POWER fallback |
| Backend  | Node.js + Express, Disk cache              |
| Build    | Vite, TypeScript                           |

## API Endpoints

### `GET /api/weather/clouds?lat={lat}&lon={lon}&time={iso}&debug={bool}`

Point-level cloud data. Primary source: **NOAA GFS 0.25°** (pressure-level cloud fraction, liquid/ice mixing ratios). Fallback: **NASA POWER** (daily low/mid/high fractions + hourly optical depth).

**Query parameters:**
| Param  | Required | Description                                      |
|--------|----------|--------------------------------------------------|
| `lat`  | yes      | Latitude, -90 to 90                              |
| `lon`  | yes      | Longitude, -180 to 180                           |
| `time` | no       | ISO 8601 timestamp (default: now)                |
| `debug`| no       | Set `true` to include raw source metadata        |

**Example (GFS response):**
```bash
curl "http://localhost:3001/api/weather/clouds?lat=37.77&lon=-122.42&time=2026-04-20T03:00Z"
```
```json
{
  "source": "GFS",
  "time": "2026-04-20T12:00:00Z",
  "levels": [1000, 925, 850, 700, 500, 300, 200],
  "cloud_fraction": [0.8, 0.6, 0.4, 0.3, 0.1, 0.05, 0.02],
  "cloud_water": [1e-4, 5e-5, 2e-5, 1e-5, 0, 0, 0],
  "cloud_ice": [0, 0, 0, 1e-6, 5e-6, 2e-6, 1e-6],
  "optical_depth": 5.2,
  "confidence": "high"
}
```

**Example (POWER fallback):**
```bash
curl "http://localhost:3001/api/weather/clouds?lat=37.77&lon=-122.42&time=2024-04-19T03:00Z"
```
```json
{
  "source": "POWER",
  "time": "2024-04-19T03:00:00Z",
  "levels": [],
  "cloud_fraction": null,
  "cloud_water": null,
  "cloud_ice": null,
  "optical_depth": 2.5,
  "confidence": "medium",
  "spatial_resolution": "~1° (CERES SYN1deg)"
}
```

**Error responses:**
| Status | Meaning                                                      |
|--------|--------------------------------------------------------------|
| 400    | Invalid lat/lon parameters                                   |
| 422    | Future date requested — POWER doesn't support future dates   |
| 503    | Both GFS and POWER sources failed                            |

### Other endpoints

```
GET /api/weather/grid?level=surface&time=...        # Single-level weather grid
GET /api/weather/cloud-layers?time=...&width=...     # 3-layer grid (low/mid/high)
GET /api/weather/cycle                                # Current GFS cycle info
GET /api/tiles/:field/:z/:x/:y.png?level=...         # Weather tiles
```

## Cloud Texture Pipeline

The `/api/tiles/cloud-texture/:z/:x/:y.png` endpoint produces 2D intensity textures (0–1 float) for volumetric cloud rendering.

### Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Base Field                                                │
│    GFS (3D cloud fraction, per-level weighted)               │
│      ↓ fails                                                 │
│    Open-Meteo (hourly cloudcover_low/mid/high from GFS)      │
│      ↓ fails                                                 │
│    POWER (CLOUD_OD → τ→density via 1-exp(-τ/8))             │
│      ↓ fails                                                 │
│    Procedural (ITCZ + storm tracks + diurnal)                │
├─────────────────────────────────────────────────────────────┤
│ 2. Satellite Detail (optional)                               │
│    GOES-16/18 visible/IR → high-frequency cloud shapes       │
│    Overlay blend: base * (1 + (sat - 0.5) * 0.3)            │
├─────────────────────────────────────────────────────────────┤
│ 3. Procedural Noise                                          │
│    FBM (4 octaves) + Worley → 3D structure                   │
│    Amplitude modulated by base density                       │
├─────────────────────────────────────────────────────────────┤
│ 4. Encode                                                    │
│    smoothstep(0, 1, base) → final intensity 0–1              │
│    JSON with Float32 data array + wind flowmap               │
└─────────────────────────────────────────────────────────────┘
```

### Shader contract

```glsl
// Input: single-channel texture T(x,y) in [0,1]
// Density field in raymarcher:
density_sample = pow(T(x,y), gamma) * height_falloff(z) * noise3D(x,y,z)
// gamma ∈ [1.2, 1.8] biases toward thick clouds

// Layering: use T.layers.low/mid/high for altitude bands
// Advection: use windU/windV to animate texture coords (flowmap)
```

### Texture response schema

```json
{
  "width": 256,
  "height": 256,
  "data": [0.0, 0.12, ...],       // intensity 0-1
  "windU": [1.2, ...],             // east-west wind (m/s)
  "windV": [-0.5, ...],            // north-south wind (m/s)
  "source": "GFS+GOES-16",        // provenance
  "timestamp": "2026-04-20T12:00:00Z",
  "bounds": { "lonMin": -10, "lonMax": 0, "latMin": 30, "latMax": 40 },
  "layers": {
    "low": [0.8, ...],            // optional, per-layer fractions
    "medium": [0.3, ...],
    "high": [0.1, ...]
  }
}
```

### Data Sources

| Source | What it provides | Resolution | Use for |
|--------|-----------------|------------|---------|
| NOAA GFS (GRIB2) | 3D cloud fraction, cloud water/ice, winds | 0.25° | Primary physical base; per-level weighted sum |
| Open-Meteo (hourly) | cloudcover_low/mid/high (GFS model) | model dependent | Quick hourly layered fallback |
| NASA POWER (CLOUD_OD) | Cloud optical depth (CERES SYN1deg) | ~1° | Thickness field; τ→density mapping |
| GOES-16/18 (AWS) | Visible/IR satellite imagery | 0.5–2 km | High-res detail overlay; real cloud shapes |

### Caching

- Cloud textures: **1 hour** TTL
- GFS GRIB2 + parsed JSON: **1 hour** TTL
- POWER responses: **1 hour** TTL
- GOES satellite: **15 minutes** (update cadence)

### POWER Constraints

- **CLOUD_OD only** — POWER fallback provides cloud optical depth via hourly CERES SYN1deg (~1° resolution)
- **No layer fractions** — CLDLOW/CLDMID/CLDHIGH are daily-only and not used; GFS and Open-Meteo provide per-level cloud fraction
- **Future dates** — POWER returns HTTP 422; the server detects this and reports accordingly
- **No API key** — both GFS (AWS Open Data) and POWER are free

### Caching

- GFS GRIB2 + parsed JSON: **1 hour** TTL
- POWER point responses: **1 hour** TTL
- ETag/Last-Modified headers on `/weather/clouds` responses
- Use `?debug=true` to see raw source URLs, timing, and parsing metadata

## Project Structure

```
AerisWeather/
├── src/                    # Client (Three.js app)
│   ├── main.ts             # Entry point
│   ├── scene/              # Scene setup, globe, atmosphere, camera
│   ├── weather/            # Weather data manager, textures, interpolation
│   ├── clouds/             # Volumetric cloud ray-marcher
│   ├── wind/               # GPU particle wind system
│   ├── shaders/            # GLSL shader sources
│   ├── ui/                 # Overlay controls (time, levels, layers)
│   └── utils/              # Math, coordinate transforms, caching
├── server/                 # Backend weather proxy
│   ├── index.ts            # Express server
│   ├── sources/            # Data source adapters (GFS, OpenWeather)
│   ├── normalize/          # Grid normalization
│   ├── tiles/              # Tile generation & caching
│   └── cache/              # Redis/disk cache layer
├── public/                 # Static assets (textures, noise volumes)
├── shaders/                # Shared GLSL (importable by both client/server if needed)
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## Performance Targets

- 60 FPS mid-range desktop GPU
- Cloud ray-march: 32–64 primary steps, 8–12 light steps
- Half/quarter-res cloud buffer + upscale + TAA
- 128³ tiled 3D noise textures
- Temporal accumulation + blue-noise dithering

## License

MIT
