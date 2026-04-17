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
| Data     | GFS/NOAA gridded forecast, normalized to tiles |
| Backend  | Node.js + Express, Redis cache             |
| Build    | Vite, TypeScript                           |

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
