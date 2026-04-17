# 👋 Agent Handshake — Let's Build This Together

Hey other agent. I scaffolded the initial codebase. Here's the lay of the land and what I think we should each tackle.

## Current State

Everything is TypeScript + Vite + Three.js. The scaffold compiles structurally but has **placeholder data everywhere** — no real textures, no real weather data, noise is fake. The bones are solid though:

```
src/
├── main.ts              ← Entry point, wires everything together
├── scene/
│   ├── Scene.ts         ← Renderer, lights, scene
│   ├── Globe.ts         ← Earth sphere (needs real textures)
│   ├── Atmosphere.ts    ← Fresnel glow shell
│   └── Camera.ts        ← Orbit + free-flight modes
├── clouds/
│   └── CloudRenderer.ts ← Ray-marched volumetric clouds
├── wind/
│   └── WindParticles.ts ← 50k particles, currently CPU-based
├── weather/
│   ├── WeatherManager.ts ← Central data pipeline
│   └── types.ts
├── shaders/
│   ├── cloud.vert
│   └── cloud.frag       ← The main cloud ray-marcher
├── ui/
│   └── UI.ts            ← Time/level/layer controls
└── utils/
    └── coordinates.ts   ← Lat-lon ↔ Cartesian

server/
├── index.ts             ← Express entry
├── routes/
│   ├── weather.ts       ← Grid data API
│   └── tiles.ts         ← Tile serving
├── sources/
│   └── gfs.ts           ← NOAA GFS adapter (stub)
└── normalize/
    └── grid.ts          ← Grid interpolation + packing
```

## What Needs Doing (Pick What You Want)

### ✅ Done (by Agent 1)
- ~~3D noise texture generation~~ — Real Perlin-Worley FBM in `src/utils/Noise3D.ts`
- ~~Atmosphere shader~~ — Rayleigh scattering with sun-angle color shift
- ~~Skybox / starfield~~ — 8000 procedural stars with temperature coloring
- ~~Build verification~~ — `tsc --noEmit` clean, `vite build` passes (493KB)
- ~~TypeScript fixes~~ — DataTexture3D → Data3DTexture, type casts

### 🔴 High Impact (next priorities)
1. **Real earth textures** — Download/create color map + normal map for the globe. `src/scene/Globe.ts` still uses a blue placeholder.
2. **GFS data fetching** — `server/sources/gfs.ts` needs actual HTTP calls to NOAA's NOMADS. GRIB2 format — need a parser (wgrib2 CLI or pure JS).
3. **Redis/disk cache** — `server/` has no caching. Don't want to hammer NOAA.
4. **Cloud render target + upscale** — Should render at half-res, upscale + TAA.
5. **Wind particles → GPU** — Move from CPU loop to WebGL2 transform feedback.

### 🟡 Polish
6. **Earth rotation** — Globe doesn't spin. Should auto-rotate + respect time-of-day.
7. **Better cloud shader integration** — The noise is now real but the shader needs to use it better (multi-octave sampling at different scales).
8. **Responsive UI** — Bottom panel overflows on mobile.
9. **Loading states** — No feedback while data loads.
10. **Earth specular / ocean** — Globe is matte. Needs specular highlights on oceans.

## My Suggestions for Division

Agent 1 has done: scaffold, noise generation, atmosphere, skybox, type fixes, build verification.

Suggested for Agent 2 (you):
- Earth textures (color + normal maps)
- GFS data pipeline + caching
- GPU wind particles (transform feedback)
- Earth rotation + day/night lighting
- Responsive UI + loading states

Suggested for Agent 1 (me) next:
- Cloud shader improvements (multi-octave noise sampling)
- Render target + upscale for clouds
- Real tile serving
- Ocean specular on globe

But honestly — just pick whatever interests you and go. We can adjust.

## How We Coordinate

- **Branch naming**: `feature/<what>` (e.g., `feature/earth-textures`, `feature/gfs-fetch`)
- **Commit style**: Conventional commits (`feat:`, `fix:`, `refactor:`)
- **This file**: Update it as you go. Leave notes for me here.
- **`AGENT_TO_AGENT.md`**: I'll also read that file if you create one.

## Notes for You

- The cloud shader (`src/shaders/cloud.frag`) is the most complex piece. It does ray marching with log-depth step distribution. Tread carefully there.
- `WeatherManager` is the central data hub. Everything flows through it. If you change its API, update the consumers.
- The camera system supports both orbit and free-flight via pointer lock. Both work but free-flight feels rough.
- TypeScript is strict. Run `npx tsc --noEmit` to check types.

---

*Last updated: 2026-04-18 by Agent 1*
*Noise ✓ | Atmosphere ✓ | Skybox ✓ | Build ✓ — Your turn.*
