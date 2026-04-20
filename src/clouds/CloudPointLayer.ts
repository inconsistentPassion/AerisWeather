/**
 * CloudPointLayer — EVE-inspired volumetric cloud visualization.
 *
 * Architecture (from EVE):
 *   Coverage Map (weather data) × 3D Noise (Perlin-Worley) × Cloud Type → density
 *
 * EVE uses raymarching through a 3D density field; we approximate with
 * dense point sprites whose fragment shaders generate procedural noise.
 *
 * Key EVE techniques adapted:
 *   1. Perlin-Worley hybrid noise (billowy base + cellular detail)
 *   2. Curl noise displacement (wispy edges)
 *   3. Coverage curves (vertical cloud profiles)
 *   4. Edge hardness (sharpness control)
 *   5. Erosion depth (how deep noise eats into cloud)
 *   6. Worley spherical (puffy vs streaky)
 *   7. Phase function approximation (forward scattering / silver lining)
 *   8. Flowmap-driven animation (wind offset)
 *   9. Cloud type map (different shapes at different locations)
 */

import maplibregl from 'maplibre-gl';
import {
  ALL_CLOUD_TYPES, evalCoverageCurve,
  getCloudTypeIndex,
} from './CloudTypes';
import { generateCloudNoise, generateHeightNoise, generateStormNoise } from '../weather/CloudNoise';

// ── Band Config ────────────────────────────────────────────────────────

interface BandConfig {
  id: string;
  cloudTypeId: string;
  altitude: number;
  altitudeSpread: number;
  color: [number, number, number];
  sizeRange: [number, number];
  opacityRange: [number, number];
  maxPoints: number;
  density: number;
  dataWeight: number;
  // EVE-inspired params passed to shader
  noiseScale: number;
  edgeHardness: number;
  erosionDepth: number;
  worleySpherical: number;
  cloudTypeIndex: number;
  // Vertical profile
  coverageCurve: [number, number][];
}

const BANDS: BandConfig[] = ALL_CLOUD_TYPES.map(ct => ({
  id: ct.id,
  cloudTypeId: ct.id,
  altitude: ct.typicalAlt,
  altitudeSpread: ct.maxAlt - ct.minAlt,
  color: ct.color,
  sizeRange: ct.sizeRange,
  opacityRange: ct.opacityRange,
  maxPoints: Math.round(ct.density * 5000),
  density: ct.density,
  dataWeight: ct.dataWeight,
  noiseScale: ct.noiseScale,
  edgeHardness: ct.edgeHardness,
  erosionDepth: ct.erosionDepth,
  worleySpherical: ct.worleySpherical,
  cloudTypeIndex: getCloudTypeIndex(ct.id),
  coverageCurve: ct.coverageCurve,
}));

// Interleaved stride: 14 floats × 4 bytes = 56 bytes
// [mercX, mercY, elevation, size, r, g, b, a, rot, cloudType, density, noiseScale, edgeHardness, erosionDepth]
const STRIDE = 56;

// ── Vertex Shader ──────────────────────────────────────────────────────

const VERT_BODY = `
  attribute vec2 aMercator;
  attribute float aElevation;
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aRot;
  attribute float aCloudType;
  attribute float aDensity;
  attribute float aNoiseScale;
  attribute float aEdgeHardness;
  attribute float aErosionDepth;

  uniform float uDPR;
  uniform float uTime;
  uniform vec2 uWindOffset;   // animated flowmap offset

  varying vec4 vColor;
  varying float vRot;
  varying float vCloudType;
  varying float vDensity;
  varying float vNoiseScale;
  varying float vEdgeHardness;
  varying float vErosionDepth;

  void main() {
    vColor = aColor;
    vRot = aRot + uTime * 0.05;
    vCloudType = aCloudType;
    vDensity = aDensity;
    vNoiseScale = aNoiseScale;
    vEdgeHardness = aEdgeHardness;
    vErosionDepth = aErosionDepth;

    gl_Position = projectTileWithElevation(aMercator, aElevation);
    float dist = max(gl_Position.w, 1.0);
    float size = aSize * uDPR * (500.0 / dist);
    gl_PointSize = clamp(size, 2.0, 250.0);
  }
`;

// ── Fragment Shader (EVE-inspired volumetric approximation) ─────────────

const FRAG = `
  precision highp float;
  varying vec4 vColor;
  varying float vRot;
  varying float vCloudType;
  varying float vDensity;
  varying float vNoiseScale;
  varying float vEdgeHardness;
  varying float vErosionDepth;
  uniform float uTime;

  // ── Noise Primitives ──────────────────────────────────────────────

  float hash(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  float hash3(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 127.4126));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1,0)), f.x),
      mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
      f.y
    );
  }

  // ── Worley Noise (EVE-style cellular) ─────────────────────────────

  // Returns (f1, f2) distances
  vec2 worleyNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float f1 = 10.0, f2 = 10.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 neighbor = vec2(float(x), float(y));
        vec2 point = vec2(
          hash(i + neighbor + vec2(73.0, 157.0)),
          hash(i + neighbor + vec2(89.0, 131.0))
        );
        float dist = length(neighbor + point - f);
        if (dist < f1) { f2 = f1; f1 = dist; }
        else if (dist < f2) { f2 = dist; }
      }
    }
    return vec2(min(f1, 1.7), min(f2, 1.7));
  }

  // 3D Worley for volumetric detail
  float worleyNoise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    float f1 = 10.0;
    for (int z = -1; z <= 1; z++) {
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 neighbor = vec3(float(x), float(y), float(z));
          vec3 pt = vec3(
            hash3(i + neighbor + vec3(73.0, 157.0, 89.0)),
            hash3(i + neighbor + vec3(97.0, 131.0, 113.0)),
            hash3(i + neighbor + vec3(61.0, 179.0, 71.0))
          );
          float dist = length(neighbor + pt - f);
          f1 = min(f1, dist);
        }
      }
    }
    return min(f1, 1.73);
  }

  // ── FBM ───────────────────────────────────────────────────────────

  float fbm(vec2 p, int octaves) {
    float value = 0.0, amp = 1.0, freq = 1.0, maxVal = 0.0;
    for (int i = 0; i < 7; i++) {
      if (i >= octaves) break;
      value += amp * valueNoise(p * freq);
      maxVal += amp; amp *= 0.5; freq *= 2.0;
    }
    return value / maxVal;
  }

  // ── Perlin-Worley Hybrid (EVE's core noise) ───────────────────────
  //
  // Smooth Perlin base + billowy Worley detail.
  // persistence controls how much Worley erodes the Perlin shape.

  float perlinWorleyHybrid(vec2 p, float persistence) {
    float perlin = fbm(p, 5);
    vec2 worley = worleyNoise(p * 1.5);
    float detail = fbm(p * 4.0, 3);
    return perlin * (1.0 - persistence * 0.5) + (1.0 - worley.x) * persistence * 0.35 + detail * 0.15;
  }

  // ── Curl Noise (EVE's wispy displacement) ─────────────────────────
  //
  // Creates divergence-free vector field for flowing cloud edges.

  vec2 curlNoise(vec2 p) {
    float eps = 0.01;
    float n_x0 = fbm(p - vec2(eps, 0.0), 3);
    float n_x1 = fbm(p + vec2(eps, 0.0), 3);
    float n_y0 = fbm(p - vec2(0.0, eps), 3);
    float n_y1 = fbm(p + vec2(0.0, eps), 3);
    return vec2(n_y1 - n_y0, -(n_x1 - n_x0)) / (2.0 * eps);
  }

  // ── Phase Function (EVE-style light scattering) ───────────────────
  //
  // Single scattering: bright, silver lining effect
  // Multiple scattering: soft, deep penetration, fluffy

  float henyeyGreenstein(float cosTheta, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
  }

  void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;

    // Rotate by wind/flow
    float c = cos(vRot), s = sin(vRot);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c);

    float r2 = dot(uv, uv);
    if (r2 > 1.0) discard;

    float scale = vNoiseScale;
    vec2 noiseUV = uv * 4.0 * scale + vRot * 0.3;

    // ── Noise Generation (EVE-style hybrid) ────────────────────────

    // Base: Perlin-Worley hybrid (billowy cloud mass)
    float baseNoise = perlinWorleyHybrid(noiseUV, 0.5);

    // Worley erosion: cellular detail for edge breakup
    vec2 worley = worleyNoise(noiseUV * 3.0);
    // Spherical parameter (EVE Release 5): makes Worley billowy
    float cellular = mix(1.0 - worley.x, worley.y - worley.x, vCloudType == 0.0 ? 1.0 : 0.3);

    // 3D detail for volumetric illusion
    float t3d = uTime * 0.02;
    float detail3D = 1.0 - worleyNoise3D(vec3(noiseUV * 2.0, t3d));

    // Curl noise displacement (EVE's wispy edges)
    vec2 curl = curlNoise(noiseUV * 2.0) * 0.08 * (1.0 - vErosionDepth * 0.5);
    vec2 displacedUV = noiseUV + curl;
    float displaced = perlinWorleyHybrid(displacedUV, 0.5);

    // Combine: base mass + cellular erosion + 3D detail
    float density = baseNoise * 0.5 + cellular * 0.25 + displaced * 0.15 + detail3D * 0.1;

    // ── Vertical Density Curve (EVE's DensityCurve) ────────────────
    //
    // Simulates EVE's per-type density curve by using gl_PointCoord.y
    // as height fraction within the sprite.
    //
    // Cumulus: denser at top, thinner at bottom
    // Cirrus: uniform thin
    // Fog: dense at bottom, fading up

    float heightFrac = gl_PointCoord.y;  // 0 = bottom, 1 = top
    float densityProfile = 1.0;

    if (vCloudType < 0.5) {
      // Cumulus: bell curve, denser at top
      densityProfile = 0.6 + 0.4 * smoothstep(0.0, 0.6, heightFrac);
    } else if (vCloudType < 1.5) {
      // Stratus: fairly uniform
      densityProfile = 0.85 + 0.15 * sin(heightFrac * 3.14159);
    } else if (vCloudType < 2.5) {
      // Cirrus: thin throughout, slight middle emphasis
      densityProfile = 0.5 + 0.5 * sin(heightFrac * 3.14159);
    } else if (vCloudType < 3.5) {
      // Cumulonimbus: thick core, wispy top
      densityProfile = heightFrac < 0.7
        ? 0.7 + 0.3 * smoothstep(0.0, 0.5, heightFrac)
        : 0.7 * (1.0 - smoothstep(0.7, 1.0, heightFrac));
    } else if (vCloudType < 4.5) {
      // Fog: dense bottom, rapid fade up
      densityProfile = 1.0 - smoothstep(0.0, 0.6, heightFrac);
    } else {
      // Altocumulus: puffy, denser in middle
      densityProfile = 0.5 + 0.5 * sin(heightFrac * 3.14159);
    }

    density *= densityProfile;

    // ── Edge Erosion (EVE's erosionDepth) ───────────────────────────
    //
    // Higher erosion = noise eats deeper into cloud, creating gaps
    // and wisps. Lower erosion = solid, blobby clouds.

    float erosionFactor = mix(1.0, detail3D, vErosionDepth);
    density *= erosionFactor;

    // ── Edge Hardness (EVE concept) ─────────────────────────────────
    //
    // Controls how sharp the cloud boundary is.
    // Low = diffuse fog, high = sharp cumulus edges.
    // Uses smoothstep width to control transition.

    float shape = 1.0 - smoothstep(0.0, 1.0, r2);
    float edgeTransition = mix(0.3, 0.03, vEdgeHardness);
    float edge = smoothstep(0.0, edgeTransition, density);
    density = shape * edge;

    if (density < 0.02) discard;

    // ── Lighting (EVE phase function approximation) ────────────────
    //
    // EVE uses 4 phase functions (2 single + 2 multiple scattering).
    // We approximate with:
    //   - Top-down light gradient (sun from above)
    //   - Forward scattering for silver lining at edges
    //   - Ambient from below (ground bounce, simplified)

    float vertical = gl_PointCoord.y;
    float sunDir = 0.7 + 0.3 * vertical;  // sun from above

    // Silver lining: bright at edges facing the light
    float edgeDist = sqrt(r2);
    float silverLining = exp(-pow((edgeDist - 0.85) * 6.0, 2.0)) * 0.3;

    // Forward scattering (Henyey-Greenstein, g=0.6 for strong forward scatter)
    float cosTheta = 1.0 - edgeDist;
    float forwardScatter = henyeyGreenstein(cosTheta, 0.6) * 0.15;

    // Multiple scattering (soft ambient, g=-0.2 for back-scatter)
    float multiScatter = henyeyGreenstein(cosTheta, -0.2) * 0.08;

    // Core glow
    float core = 1.0 + 0.1 * exp(-r2 * 3.0);

    // Combine
    float light = sunDir * core + silverLining + forwardScatter + multiScatter;

    vec3 color = vColor.rgb * light;
    float alpha = density * vColor.a;

    gl_FragColor = vec4(color, alpha);
  }
`;

// ── Helpers ────────────────────────────────────────────────────────────

function compileShader(gl: WebGLRenderingContext, type: number, src: string, prelude?: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, prelude ? `${prelude}\n${src}` : src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[Clouds] Shader:', gl.getShaderInfoLog(s));
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

// ── Main Class ─────────────────────────────────────────────────────────

export class CloudPointLayer {
  private map: maplibregl.Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbos: Map<string, { buf: WebGLBuffer; count: number }> = new Map();
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private visible = true;
  private dirty = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private shaderPrelude = '';
  private shaderDefine = '';

  // Wind animation state
  private windOffsetX = 0;
  private windOffsetY = 0;
  private windTimer: ReturnType<typeof setInterval> | null = null;

  // Noise textures for CPU-side density modulation
  private cloudNoise: Float32Array | null = null;
  private heightNoise: Float32Array | null = null;
  private stormNoise: Float32Array | null = null;
  private noiseW = 256;
  private noiseH = 128;

  // Coverage map (from live-cloud-maps)
  private coverageData: Float32Array | null = null;
  private coverageW = 0;
  private coverageH = 0;

  constructor() {
    // Pre-generate noise textures
    this.generateNoiseTextures();
  }

  private generateNoiseTextures(seed: number = 42): void {
    this.cloudNoise = generateCloudNoise(this.noiseW, this.noiseH, seed);
    this.heightNoise = generateHeightNoise(this.noiseW, this.noiseH, seed + 33);
    this.stormNoise = generateStormNoise(this.noiseW, this.noiseH, seed + 77);
  }

  getLayer(): maplibregl.CustomLayerInterface {
    const self = this;
    return {
      id: 'cloud-points-3d',
      type: 'custom',
      renderingMode: '3d',

      onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
        self.map = map;
        for (const band of BANDS) {
          self.vbos.set(band.id, { buf: gl.createBuffer()!, count: 0 });
        }

        // Periodic re-upload for data updates
        self.timer = setInterval(() => {
          if (self.visible && self.dirty) self.upload(gl);
        }, 8000);

        // Wind animation: update offset every 200ms
        self.windTimer = setInterval(() => {
          self.updateWindOffset();
        }, 200);

        self.upload(gl);
      },

      render(gl: WebGLRenderingContext, args: any) {
        if (!self.visible) return;

        // Compile shaders on first render
        if (!self.program && args?.shaderData) {
          self.shaderPrelude = args.shaderData.vertexShaderPrelude || '';
          self.shaderDefine = args.shaderData.define || '';
          const prelude = `${self.shaderPrelude}\n${self.shaderDefine}`;
          try {
            const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_BODY, prelude);
            const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
            self.program = gl.createProgram()!;
            gl.attachShader(self.program, vs);
            gl.attachShader(self.program, fs);
            gl.linkProgram(self.program);
            if (!gl.getProgramParameter(self.program, gl.LINK_STATUS)) {
              console.error('[Clouds] Link:', gl.getProgramInfoLog(self.program));
              self.program = null;
              return;
            }
            gl.deleteShader(vs); gl.deleteShader(fs);

            // Cache uniform locations
            self.uniforms.uDPR = gl.getUniformLocation(self.program, 'uDPR');
            self.uniforms.uTime = gl.getUniformLocation(self.program, 'uTime');
            self.uniforms.uWindOffset = gl.getUniformLocation(self.program, 'uWindOffset');
            console.log('[Clouds] EVE-inspired shader compiled');
          } catch (e) {
            console.error('[Clouds] Shader compilation failed:', e);
            return;
          }
        }
        if (!self.program) return;

        gl.useProgram(self.program);
        gl.uniform1f(self.uniforms.uDPR, window.devicePixelRatio || 1);
        gl.uniform1f(self.uniforms.uTime, (Date.now() - self.startTime) * 0.001);
        gl.uniform2f(self.uniforms.uWindOffset, self.windOffsetX, self.windOffsetY);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);

        // Attribute locations
        const attrs: Record<string, number> = {};
        const attrNames = ['aMercator','aElevation','aSize','aColor','aRot',
                           'aCloudType','aDensity','aNoiseScale','aEdgeHardness','aErosionDepth'];
        for (const name of attrNames) {
          attrs[name] = gl.getAttribLocation(self.program!, name);
        }

        // Render bands back-to-front (high altitude first, then low)
        // This approximates EVE's overlapRenderOrder (densest first)
        for (const band of [...BANDS].reverse()) {
          const vb = self.vbos.get(band.id);
          if (!vb || vb.count === 0) continue;

          gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);

          // Bind interleaved attributes
          const a = attrs;
          gl.enableVertexAttribArray(a.aMercator);
          gl.vertexAttribPointer(a.aMercator, 2, gl.FLOAT, false, STRIDE, 0);

          gl.enableVertexAttribArray(a.aElevation);
          gl.vertexAttribPointer(a.aElevation, 1, gl.FLOAT, false, STRIDE, 8);

          gl.enableVertexAttribArray(a.aSize);
          gl.vertexAttribPointer(a.aSize, 1, gl.FLOAT, false, STRIDE, 12);

          gl.enableVertexAttribArray(a.aColor);
          gl.vertexAttribPointer(a.aColor, 4, gl.FLOAT, false, STRIDE, 16);

          gl.enableVertexAttribArray(a.aRot);
          gl.vertexAttribPointer(a.aRot, 1, gl.FLOAT, false, STRIDE, 32);

          gl.enableVertexAttribArray(a.aCloudType);
          gl.vertexAttribPointer(a.aCloudType, 1, gl.FLOAT, false, STRIDE, 36);

          gl.enableVertexAttribArray(a.aDensity);
          gl.vertexAttribPointer(a.aDensity, 1, gl.FLOAT, false, STRIDE, 40);

          gl.enableVertexAttribArray(a.aNoiseScale);
          gl.vertexAttribPointer(a.aNoiseScale, 1, gl.FLOAT, false, STRIDE, 44);

          gl.enableVertexAttribArray(a.aEdgeHardness);
          gl.vertexAttribPointer(a.aEdgeHardness, 1, gl.FLOAT, false, STRIDE, 48);

          gl.enableVertexAttribArray(a.aErosionDepth);
          gl.vertexAttribPointer(a.aErosionDepth, 1, gl.FLOAT, false, STRIDE, 52);

          gl.drawArrays(gl.POINTS, 0, vb.count);
        }

        // Cleanup
        for (const name of attrNames) {
          gl.disableVertexAttribArray(attrs[name]);
        }
        gl.depthMask(true);
      },

      onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext) {
        if (self.timer) clearInterval(self.timer);
        if (self.windTimer) clearInterval(self.windTimer);
        for (const [, vb] of self.vbos) gl.deleteBuffer(vb.buf);
        if (self.program) gl.deleteProgram(self.program);
        self.vbos.clear();
      },
    };
  }

  // ── Wind Animation ────────────────────────────────────────────────

  private updateWindOffset(): void {
    // Slow global drift — simulates average wind flow
    this.windOffsetX += 0.0002;
    this.windOffsetY += 0.00005;
  }

  // ── Data Upload (EVE-style: texture brightness → particle placement) ─

  /**
   * EVE approach: the cloud texture IS the cloud definition.
   * Brightness at each pixel directly controls:
   *   - Whether clouds exist (threshold)
   *   - How many particles (brightness → count)
   *   - How large they are (brightness → size)
   *   - Their opacity (brightness → alpha)
   *   - Altitude distribution (noise → height variation)
   */
  private upload(gl: WebGLRenderingContext): void {
    if (!this.coverageData) {
      // No coverage data yet — wait for LiveCloudMap to provide it
      for (const band of BANDS) this.vbos.get(band.id)!.count = 0;
      this.dirty = false;
      return;
    }

    const cloudData = this.coverageData;
    const w = this.coverageW;
    const h = this.coverageH;

    for (const band of BANDS) {
      const pts = new Float32Array(band.maxPoints * 14);
      let n = 0;

      for (let j = 0; j < h && n < band.maxPoints; j++) {
        for (let i = 0; i < w && n < band.maxPoints; i++) {
          const brightness = cloudData[j * w + i];

          // EVE: threshold — skip clear pixels
          if (brightness < 0.15) continue;

          // Height variation from noise
          let heightMod = 1.0;
          if (this.heightNoise) {
            const ni = Math.floor((i / w) * (this.noiseW - 1));
            const nj = Math.floor((j / h) * (this.noiseH - 1));
            heightMod = 0.4 + this.heightNoise[nj * this.noiseW + ni] * 0.6;
          }

          // EVE: brightness directly → number of particles
          // Bright pixels get more particles, dark pixels get fewer
          const numPts = Math.max(1, Math.ceil(brightness * band.density));

          const lon = (i / w) * 360 - 180 + 0.5;
          const lat = 90 - (j / h) * 180 - 0.5;

          for (let p = 0; p < numPts && n < band.maxPoints; p++) {
            const jLon = (Math.random() - 0.5) * (360 / w) * 1.1;
            const jLat = (Math.random() - 0.5) * (180 / h) * 1.1;

            // Altitude with coverage curve
            const altFrac = Math.random();
            const curveVal = evalCoverageCurve(band.coverageCurve, altFrac);
            if (curveVal < 0.05 && Math.random() > 0.3) continue;

            const altMeters = Math.max(
              10,
              band.altitude + (altFrac - 0.5) * band.altitudeSpread * heightMod
            );

            const clampLat = Math.max(-85, Math.min(85, lat + jLat));
            const m = toMercator(clampLat, lon + jLon);

            // EVE: brightness → size and opacity
            const sizeVar = band.sizeRange[0]
              + brightness * (band.sizeRange[1] - band.sizeRange[0])
              * (0.5 + Math.random() * 0.5) * curveVal;
            const alpha = (band.opacityRange[0]
              + brightness * (band.opacityRange[1] - band.opacityRange[0]))
              * curveVal;
            const rot = Math.random() * Math.PI * 2;

            const o = n * 14;
            pts[o]    = m.x;
            pts[o+1]  = m.y;
            pts[o+2]  = altMeters;
            pts[o+3]  = sizeVar;
            pts[o+4]  = band.color[0];
            pts[o+5]  = band.color[1];
            pts[o+6]  = band.color[2];
            pts[o+7]  = Math.min(1, alpha);
            pts[o+8]  = rot;
            pts[o+9]  = band.cloudTypeIndex;
            pts[o+10] = brightness;
            pts[o+11] = band.noiseScale;
            pts[o+12] = band.edgeHardness;
            pts[o+13] = band.erosionDepth;
            n++;
          }
        }
      }

      const data = pts.subarray(0, n * 14);
      const vb = this.vbos.get(band.id)!;
      gl.bindBuffer(gl.ARRAY_BUFFER, vb.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      vb.count = n;
    }

    this.dirty = false;
    const total = [...this.vbos.values()].reduce((s, b) => s + b.count, 0);
    console.log(
      `[Clouds] ${total} pts from texture (${w}x${h}): ` +
      BANDS.map(b => `${b.id}=${this.vbos.get(b.id)!.count}`).join(' ')
    );
  }

  setCoverageMap(map: { data: Float32Array; width: number; height: number; source: string }): void {
    this.coverageData = map.data;
    this.coverageW = map.width;
    this.coverageH = map.height;
    this.dirty = true;
    console.log(`[Clouds] Coverage map set: ${map.width}x${map.height} (${map.source})`);
    this.map?.triggerRepaint();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) this.dirty = true;
    this.map?.triggerRepaint();
  }
}
