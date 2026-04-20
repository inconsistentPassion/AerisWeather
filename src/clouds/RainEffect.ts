/**
 * RainEffect — WebGL rain streaks on the MapLibre globe.
 *
 * Projects rain drops in the vertex shader (no map.project() calls).
 * Spawns drops in precipitation cells from RainViewer radar data.
 */

import maplibregl from 'maplibre-gl';

const MAX_DROPS = 5000;
const SPAWN_PER_FRAME = 120;
const TILE_PX = 256;
const RAINDVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_INTERVAL = 10 * 60 * 1000;

const NUM_BINS = 5;
const BIN_COLORS: [number, number, number, number][] = [
  [90, 140, 210, 0.20],
  [130, 180, 235, 0.30],
  [170, 215, 255, 0.42],
  [210, 235, 255, 0.55],
  [245, 250, 255, 0.68],
];

// ── Shader ────────────────────────────────────────────────────────────

// Vertex shader — uses MapLibre's projectTileWithElevation for correct globe projection
const VERT_BODY = `
  attribute vec2 aMercator;   // mercator x,y [0,1]
  attribute float aElevation; // elevation above surface in meters
  attribute float aAlpha;

  varying float vAlpha;

  void main() {
    vAlpha = aAlpha;
    gl_Position = projectTileWithElevation(aMercator, aElevation);
    gl_PointSize = 1.5;
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

// ── Main class ────────────────────────────────────────────────────────

interface PrecipCell { lon: number; lat: number; halfLon: number; halfLat: number; intensity: number; }
interface Drop { lon: number; lat: number; fall: number; speed: number; length: number; intensity: number; age: number; maxAge: number; }

interface BinGL { vbo: WebGLBuffer; count: number; }

export class RainEffect {
  private map: maplibregl.Map;
  private weather_active = true;
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

  constructor(map: maplibregl.Map) {
    this.map = map;
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
          const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_BODY, prelude);
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
                const lum = (0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2]) / 255;
                const intensity = lum * (px[i+3] / 255);
                if (intensity > 0.08) {
                  const lon = pixelToLon(tx, pxx + STRIDE / 2, zoom);
                  const lat = pixelToLat(ty, py + STRIDE / 2, zoom);
                  const cs = (360 / (1 << zoom)) / TILE_PX * STRIDE;
                  cells.push({ lon, lat, halfLon: cs, halfLat: cs * 0.5, intensity: Math.min(1, intensity * 1.5) });
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

  private tick(): void {
    if (!this.visible) {
      for (let b = 0; b < NUM_BINS; b++) this.bins.get(b)!.count = 0;
      return;
    }

    // Spawn
    if (this.cells.length > 0) {
      for (let i = 0; i < SPAWN_PER_FRAME; i++) {
        const cell = this.cells[Math.floor(Math.random() * this.cells.length)];
        if (Math.random() > cell.intensity) continue;
        this.drops.push({
          lon: cell.lon + (Math.random() - 0.5) * cell.halfLon * 2,
          lat: cell.lat + (Math.random() - 0.5) * cell.halfLat * 2,
          fall: Math.random() * 0.3,
          speed: 0.015 + Math.random() * 0.018 + cell.intensity * 0.008,
          length: 0.4 + Math.random() * 0.5 + cell.intensity * 0.3,
          intensity: cell.intensity,
          age: 0,
          maxAge: 50 + Math.floor(Math.random() * 50),
        });
      }
      if (this.drops.length > MAX_DROPS) this.drops.splice(0, this.drops.length - MAX_DROPS);
    }

    // Build geometry per bin
    const segsByBin: Float32Array[] = [];
    const countByBin = new Int32Array(NUM_BINS);
    const maxSegs = Math.ceil(MAX_DROPS / NUM_BINS);
    for (let b = 0; b < NUM_BINS; b++) segsByBin.push(new Float32Array(maxSegs * 8));

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age++; d.fall += d.speed;
      if (d.fall >= 1 || d.age >= d.maxAge) {
        this.drops[i] = this.drops[this.drops.length - 1];
        this.drops.pop();
        continue;
      }

      // Rain drop as a short line on globe surface (lat offset = falling motion)
      const dropOffset = d.length * 0.2;
      const tailLat = d.lat - dropOffset * (d.fall - 0.5);
      const headLat = d.lat - dropOffset * (d.fall + 0.5);
      if (Math.abs(headLat) > 90 || Math.abs(tailLat) > 90) continue;

      const m0 = toMercator(tailLat, d.lon);
      const m1 = toMercator(headLat, d.lon);
      // Elevation: slight offset above surface for rain visual
      const elev0 = 100 + d.fall * 2000;
      const elev1 = 100 + (d.fall + 0.1) * 2000;

      const bin = Math.min(NUM_BINS - 1, Math.floor(d.intensity * NUM_BINS));
      const ageFade = d.age < 8 ? d.age / 8 : d.fall > 0.8 ? (1 - d.fall) / 0.2 : 1;
      const alpha = Math.max(0, ageFade);

      const segs = segsByBin[bin];
      const sc = countByBin[bin];
      const maxS = segs.length / 8;
      if (sc >= maxS) continue;

      const off = sc * 8;
      segs[off] = m0.x; segs[off+1] = m0.y; segs[off+2] = elev0; segs[off+3] = alpha;
      segs[off+4] = m1.x; segs[off+5] = m1.y; segs[off+6] = elev1; segs[off+7] = alpha * 0.8;
      countByBin[bin] = sc + 1;
    }

    // Upload
    const gl = this.gl;
    if (!gl) return;

    for (let b = 0; b < NUM_BINS; b++) {
      const bg = this.bins.get(b)!;
      const count = countByBin[b];
      if (count > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bg.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, segsByBin[b].subarray(0, count * 8), gl.DYNAMIC_DRAW);
        bg.count = count * 2; // GL_LINES vertices
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
