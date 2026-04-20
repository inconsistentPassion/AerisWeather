/**
 * RainEffect — Vertical rain streaks driven by real radar data.
 *
 * Rain drops spawn at cloud base altitude and fall vertically
 * (straight down in elevation) to the ground — like Xiaomi HyperOS
 * weather app style. Driven by RainViewer radar precipitation data.
 */

import maplibregl from 'maplibre-gl';

// ── Configuration ─────────────────────────────────────────────────────

const MAX_DROPS = 20000;
const SPAWN_PER_FRAME = 400;
const TILE_PX = 256;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_INTERVAL = 10 * 60 * 1000;

/** Cloud base altitude range (meters) — where rain spawns */
const CLOUD_BASE_MIN = 800;
const CLOUD_BASE_MAX = 3000;

/** Ground level (meters) — where rain despawns */
const GROUND_LEVEL = 5;

const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [90, 140, 210, 0.25],
  [130, 180, 235, 0.35],
  [170, 215, 255, 0.48],
  [210, 235, 255, 0.60],
  [245, 250, 255, 0.72],
];

// ── Shaders ───────────────────────────────────────────────────────────

const VERT_BODY = `
  attribute vec2 aMercator;     // mercator x,y [0,1] — fixed position
  attribute float aTopElev;     // top of rain streak (meters)
  attribute float aBotElev;     // bottom of rain streak (meters)
  attribute float aAlpha;       // fade factor

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;

    // Use the top elevation for projection (the line goes from top to bottom)
    gl_Position = projectTileWithElevation(aMercator, aTopElev);
    gl_PointSize = 1.5;
  }
`;

// Line vertex shader — each drop is a vertical line segment
const LINE_VERT = `
  attribute vec2 aMercator;
  attribute float aElevation;   // top or bottom elevation
  attribute float aAlpha;

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    gl_Position = projectTileWithElevation(aMercator, aElevation);
  }
`;

const FRAG = `
  precision mediump float;
  varying float vAlpha;
  uniform vec4 uColor;

  void main() {
    gl_FragColor = vec4(uColor.rgb, uColor.a * vAlpha);
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string, prelude?: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, prelude ? `${prelude}\n${src}` : src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[Rain] Shader error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    throw new Error('shader');
  }
  return s;
}

function toMercator(lat: number, lon: number): { x: number; y: number } {
  const x = (lon + 180) / 360;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

function pixelToLon(tx: number, px: number, z: number) {
  return ((tx + px / TILE_PX) / (1 << z)) * 360 - 180;
}
function pixelToLat(ty: number, py: number, z: number) {
  const n = Math.PI - 2 * Math.PI * (ty + py / TILE_PX) / (1 << z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ── Types ─────────────────────────────────────────────────────────────

interface PrecipCell {
  lon: number;
  lat: number;
  halfLon: number;
  halfLat: number;
  intensity: number;
}

interface Drop {
  lon: number;
  lat: number;
  /** Current elevation (starts at cloudBase, falls to ground) */
  elev: number;
  /** Cloud base where this drop spawned */
  cloudBase: number;
  /** Fall speed in meters per frame */
  fallSpeed: number;
  /** Streak length in meters */
  streakLength: number;
  intensity: number;
  age: number;
  maxAge: number;
  /** Wind drift — small horizontal offset that accumulates */
  driftLon: number;
  driftLat: number;
}

interface BinGL { vbo: WebGLBuffer; count: number; }

// ── Main class ────────────────────────────────────────────────────────

export class RainEffect {
  private map: maplibregl.Map;
  private weather: any = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private bins: Map<number, BinGL> = new Map();
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private visible = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private cells: PrecipCell[] = [];
  private drops: Drop[] = [];
  private shaderPrelude = '';
  private shaderDefine = '';

  constructor(map: maplibregl.Map, weather?: any) {
    this.map = map;
    this.weather = weather;
    this.loadRadar();
    this.refreshTimer = setInterval(() => this.loadRadar(), REFRESH_INTERVAL);
  }

  getLayer(): maplibregl.CustomLayerInterface {
    const self = this;
    return {
      id: 'rain-lines',
      type: 'custom',
      renderingMode: '3d',

      onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
        self.gl = gl;
        for (let b = 0; b < NUM_BINS; b++) {
          self.bins.set(b, { vbo: gl.createBuffer()!, count: 0 });
        }
        console.log('[Rain] WebGL layer added');
      },

      render(gl: WebGLRenderingContext, args: any) {
        if (!self.visible) return;

        // Lazy shader compilation
        if (!self.program && args?.shaderData) {
          self.shaderPrelude = args.shaderData.vertexShaderPrelude || '';
          self.shaderDefine = args.shaderData.define || '';
          const prelude = `${self.shaderPrelude}\n${self.shaderDefine}`;
          const vs = compileShader(gl, gl.VERTEX_SHADER, LINE_VERT, prelude);
          const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
          self.program = gl.createProgram()!;
          gl.attachShader(self.program, vs);
          gl.attachShader(self.program, fs);
          gl.linkProgram(self.program);
          if (!gl.getProgramParameter(self.program, gl.LINK_STATUS)) {
            console.error('[Rain] Link error:', gl.getProgramInfoLog(self.program));
            self.program = null;
            return;
          }
          gl.deleteShader(vs);
          gl.deleteShader(fs);

          self.uniforms.uColor = gl.getUniformLocation(self.program, 'uColor');
          console.log('[Rain] Shader compiled');
        }
        if (!self.program) return;

        // Tick simulation
        self.tick();

        // Draw
        gl.useProgram(self.program);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        const aMercator = gl.getAttribLocation(self.program, 'aMercator');
        const aElevation = gl.getAttribLocation(self.program, 'aElevation');
        const aAlpha = gl.getAttribLocation(self.program, 'aAlpha');

        for (let b = 0; b < NUM_BINS; b++) {
          const bg = self.bins.get(b)!;
          if (bg.count === 0) continue;

          const [r, g, bl, a] = BIN_COLORS[b];
          gl.uniform4f(self.uniforms.uColor, r / 255, g / 255, bl / 255, 1.0);

          gl.bindBuffer(gl.ARRAY_BUFFER, bg.vbo);
          // Each vertex: mercator(2) + elevation(1) + alpha(1) = 4 floats = 16 bytes
          const stride = 16;
          gl.enableVertexAttribArray(aMercator);
          gl.vertexAttribPointer(aMercator, 2, gl.FLOAT, false, stride, 0);
          gl.enableVertexAttribArray(aElevation);
          gl.vertexAttribPointer(aElevation, 1, gl.FLOAT, false, stride, 8);
          gl.enableVertexAttribArray(aAlpha);
          gl.vertexAttribPointer(aAlpha, 1, gl.FLOAT, false, stride, 12);

          gl.drawArrays(gl.LINES, 0, bg.count);
        }

        gl.disableVertexAttribArray(aMercator);
        gl.disableVertexAttribArray(aElevation);
        gl.disableVertexAttribArray(aAlpha);
        gl.depthMask(true);
      },

      onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext) {
        for (const [, bg] of self.bins) gl.deleteBuffer(bg.vbo);
        if (self.program) gl.deleteProgram(self.program);
        self.bins.clear();
      },
    };
  }

  // ── Radar data ──────────────────────────────────────────────────────

  private async loadRadar(): Promise<void> {
    try {
      const res = await fetch(RAINDVIEWER_API);
      if (!res.ok) return;
      const data = await res.json();
      const host = data.host || 'https://tilecache.rainviewer.com';
      const past = data.radar?.past || [];
      if (!past.length) return;
      const latest = past[past.length - 1];
      const basePath = `${host}${latest.path}/256`;
      const zoom = 3;
      const cells: PrecipCell[] = [];
      const STRIDE = 4;

      const tiles: Array<{ url: string; tx: number; ty: number }> = [];
      for (let ty = 0; ty < (1 << zoom); ty++)
        for (let tx = 0; tx < (1 << zoom); tx++)
          tiles.push({ url: `${basePath}/${zoom}/${tx}/${ty}/2/1_1.png`, tx, ty });

      await Promise.all(tiles.map(({ url, tx, ty }) =>
        new Promise<void>(resolve => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = TILE_PX; c.height = TILE_PX;
            const cx = c.getContext('2d')!;
            cx.drawImage(img, 0, 0);
            const px = cx.getImageData(0, 0, TILE_PX, TILE_PX).data;
            for (let py = 0; py < TILE_PX; py += STRIDE) {
              for (let pxx = 0; pxx < TILE_PX; pxx += STRIDE) {
                const i = (py * TILE_PX + pxx) * 4;
                const lum = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
                const intensity = lum * (px[i + 3] / 255);
                if (intensity > 0.08) {
                  const lon = pixelToLon(tx, pxx + STRIDE / 2, zoom);
                  const lat = pixelToLat(ty, py + STRIDE / 2, zoom);
                  const cs = (360 / (1 << zoom)) / TILE_PX * STRIDE;
                  cells.push({
                    lon, lat,
                    halfLon: cs,
                    halfLat: cs * 0.5,
                    intensity: Math.min(1, intensity * 1.5),
                  });
                }
              }
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        })
      ));

      this.cells = cells;
      console.log(`[Rain] ${cells.length} precip cells`);
    } catch (e) {
      console.warn('[Rain] Radar load failed:', e);
    }
  }

  // ── Simulation tick ─────────────────────────────────────────────────

  private tick(): void {
    if (!this.visible) {
      for (let b = 0; b < NUM_BINS; b++) this.bins.get(b)!.count = 0;
      return;
    }

    // Spawn new drops
    if (this.cells.length > 0) {
      for (let i = 0; i < SPAWN_PER_FRAME; i++) {
        const cell = this.cells[Math.floor(Math.random() * this.cells.length)];
        if (Math.random() > cell.intensity) continue;

        // Cloud base varies with intensity — heavier rain comes from lower (thicker) clouds
        const cloudBase = CLOUD_BASE_MIN + (1 - cell.intensity) * (CLOUD_BASE_MAX - CLOUD_BASE_MIN);

        this.drops.push({
          lon: cell.lon + (Math.random() - 0.5) * cell.halfLon * 2,
          lat: cell.lat + (Math.random() - 0.5) * cell.halfLat * 2,
          elev: cloudBase,
          cloudBase,
          fallSpeed: 40 + Math.random() * 60 + cell.intensity * 30, // meters per frame
          streakLength: 100 + Math.random() * 200 + cell.intensity * 150,
          intensity: cell.intensity,
          age: 0,
          maxAge: 60 + Math.floor(Math.random() * 60),
          driftLon: (Math.random() - 0.5) * 0.001,
          driftLat: (Math.random() - 0.5) * 0.0005,
        });
      }
      if (this.drops.length > MAX_DROPS) this.drops.splice(0, this.drops.length - MAX_DROPS);
    }

    // Build geometry per bin — each drop = 1 line segment = 2 vertices
    const segsByBin: Float32Array[] = [];
    const countByBin = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DROPS / NUM_BINS);
    for (let b = 0; b < NUM_BINS; b++) segsByBin.push(new Float32Array(maxSegs * 8));

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age++;
      d.elev -= d.fallSpeed;

      // Accumulate wind drift
      d.lon += d.driftLon;
      d.lat += d.driftLat;

      // Drop reaches ground → remove
      if (d.elev <= GROUND_LEVEL || d.age >= d.maxAge) {
        this.drops[i] = this.drops[this.drops.length - 1];
        this.drops.pop();
        continue;
      }

      // Skip if out of bounds
      if (Math.abs(d.lat) > 85) continue;

      // Streak: from current elevation (bottom) up to streak length (top)
      const botElev = d.elev;
      const topElev = d.elev + d.streakLength;

      // Same mercator position for both ends — purely vertical streak
      const m = toMercator(d.lat, d.lon);

      // Age-based fade: fade in at spawn, fade out near ground
      const ageFade = d.age < 6 ? d.age / 6 : 1.0;
      const groundFade = botElev < 200 ? botElev / 200 : 1.0;
      const alpha = Math.max(0, ageFade * groundFade);

      const bin = Math.min(NUM_BINS - 1, Math.floor(d.intensity * NUM_BINS));
      const segs = segsByBin[bin];
      const sc = countByBin[bin];
      const maxS = segs.length / 8;
      if (sc >= maxS) continue;

      const off = sc * 8;
      // Top vertex
      segs[off]     = m.x;
      segs[off + 1] = m.y;
      segs[off + 2] = topElev;
      segs[off + 3] = alpha * 0.6; // top fades more
      // Bottom vertex
      segs[off + 4] = m.x;
      segs[off + 5] = m.y;
      segs[off + 6] = botElev;
      segs[off + 7] = alpha;

      countByBin[bin] = sc + 1;
    }

    // Upload to GPU
    const gl = this.gl;
    if (!gl) return;

    for (let b = 0; b < NUM_BINS; b++) {
      const bg = this.bins.get(b)!;
      const count = countByBin[b];
      if (count > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bg.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, segsByBin[b].subarray(0, count * 8), gl.DYNAMIC_DRAW);
        bg.count = count * 2; // GL_LINES: 2 vertices per segment
      } else {
        bg.count = 0;
      }
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.map?.triggerRepaint();
  }

  destroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
