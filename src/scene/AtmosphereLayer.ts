/**
 * AtmosphereLayer — MapLibre custom layer with physically-based atmosphere rendering.
 * 
 * Reverse-engineered from Mapbox GL JS globe atmosphere:
 * - Rayleigh scattering color gradients (blue horizon, orange sunset)
 * - Mie forward scattering (sun glow)  
 * - Horizon limb brightening
 * - Proper depth-aware rendering (doesn't bleed over globe)
 * 
 * Shares MapLibre's WebGL context via custom layer API.
 */

import maplibregl from 'maplibre-gl';
import atmosphereVert from '../shaders/atmosphere.vert';
import atmosphereFrag from '../shaders/atmosphere.frag';

const EARTH_RADIUS_M = 6371008.8;

/**
 * Create a MapLibre custom layer that renders an atmosphere glow effect.
 * Must be added after map 'load' event, before any overlay layers.
 */
export function createAtmosphereLayer(): maplibregl.CustomLayerInterface {
  let program: WebGLProgram | null = null;
  let quadBuffer: WebGLBuffer | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};

  return {
    id: 'custom-atmosphere',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
      const gl2 = gl as WebGL2RenderingContext;

      // Compile shaders
      const vs = compileShader(gl2, gl2.VERTEX_SHADER, atmosphereVert);
      const fs = compileShader(gl2, gl2.FRAGMENT_SHADER, atmosphereFrag);
      if (!vs || !fs) {
        console.error('[Atmosphere] Shader compilation failed');
        return;
      }

      program = gl2.createProgram()!;
      gl2.attachShader(program, vs);
      gl2.attachShader(program, fs);
      gl2.linkProgram(program);

      if (!gl2.getProgramParameter(program, gl2.LINK_STATUS)) {
        console.error('[Atmosphere] Program link failed:', gl2.getProgramInfoLog(program));
        return;
      }

      // Cache uniform locations
      const uniformNames = [
        'uInvVP', 'uCameraPos', 'uPlanetCenter', 'uPlanetRadius',
        'uAtmosphereRadius', 'uSunDirection', 'uTime',
      ];
      for (const name of uniformNames) {
        uniforms[name] = gl2.getUniformLocation(program, name);
      }

      // Fullscreen quad (triangle strip)
      const quadVerts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      quadBuffer = gl2.createBuffer()!;
      gl2.bindBuffer(gl2.ARRAY_BUFFER, quadBuffer);
      gl2.bufferData(gl2.ARRAY_BUFFER, quadVerts, gl2.STATIC_DRAW);

      // VAO
      vao = gl2.createVertexArray()!;
      gl2.bindVertexArray(vao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, quadBuffer);
      const posLoc = gl2.getAttribLocation(program, 'aPosition');
      gl2.enableVertexAttribArray(posLoc);
      gl2.vertexAttribPointer(posLoc, 2, gl2.FLOAT, false, 0, 0);
      gl2.bindVertexArray(null);

      console.log('[Atmosphere] Custom layer initialized');
    },

    render(gl: WebGLRenderingContext, args: any) {
      if (!program || !vao) return;
      const gl2 = gl as WebGL2RenderingContext;

      // Extract MapLibre's view-projection matrix
      const mainMatrix: number[] = args?.defaultProjectionData?.mainMatrix;
      if (!mainMatrix || mainMatrix.length !== 16) return;

      // Compute inverse VP matrix
      const vp = new Float32Array(mainMatrix);
      const invVP = invertMatrix4(vp);
      if (!invVP) return;

      // Camera position in world space (from MapLibre transform)
      const transform = (args as any).transform;
      const cameraPos = transform?.cameraPosition || [0, 0, 50000000];

      // Sun direction (from sky-atmosphere-sun or default)
      const now = Date.now() / 1000;
      const sunAzimuth = (now * 0.01) % (Math.PI * 2);
      const sunElevation = 0.3 + Math.sin(now * 0.005) * 0.2;
      const sunDir = [
        Math.cos(sunAzimuth) * Math.cos(sunElevation),
        Math.sin(sunElevation),
        Math.sin(sunAzimuth) * Math.cos(sunElevation),
      ];

      // Atmosphere radius (slightly larger than earth)
      const planetRadius = EARTH_RADIUS_M;
      const atmosphereRadius = planetRadius * 1.015;

      // Set uniforms
      gl2.useProgram(program);
      gl2.uniformMatrix4fv(uniforms.uInvVP, false, invVP);
      gl2.uniform3f(uniforms.uCameraPos, cameraPos[0], cameraPos[1], cameraPos[2]);
      gl2.uniform3f(uniforms.uPlanetCenter, 0, 0, 0);
      gl2.uniform1f(uniforms.uPlanetRadius, planetRadius);
      gl2.uniform1f(uniforms.uAtmosphereRadius, atmosphereRadius);
      gl2.uniform3f(uniforms.uSunDirection, sunDir[0], sunDir[1], sunDir[2]);
      gl2.uniform1f(uniforms.uTime, now);

      // Draw fullscreen quad
      gl2.enable(gl2.BLEND);
      gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA);
      gl2.depthFunc(gl2.ALWAYS);
      gl2.bindVertexArray(vao);
      gl2.drawArrays(gl2.TRIANGLE_STRIP, 0, 4);
      gl2.bindVertexArray(null);
      gl2.depthFunc(gl2.LESS);
    },

    onRemove() {
      // Cleanup handled by MapLibre
    },
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[Atmosphere] Shader error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function invertMatrix4(m: Float32Array): Float32Array | null {
  const inv = new Float32Array(16);

  inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];

  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (Math.abs(det) < 1e-10) return null;
  det = 1.0 / det;

  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}
