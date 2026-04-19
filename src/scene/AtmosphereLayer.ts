/**
 * AtmosphereLayer — MapLibre custom layer with Rayleigh scattering atmosphere.
 * WebGL 1 compatible (no VAO, no WebGL2 cast).
 */

import maplibregl from 'maplibre-gl';
import atmosphereVert from '../shaders/atmosphere.vert';
import atmosphereFrag from '../shaders/atmosphere.frag';

const EARTH_RADIUS_M = 6371008.8;

export function createAtmosphereLayer(): maplibregl.CustomLayerInterface {
  let program: WebGLProgram | null = null;
  let quadBuffer: WebGLBuffer | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let posLoc = -1;

  return {
    id: 'custom-atmosphere',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
      const vs = compileShader(gl, gl.VERTEX_SHADER, atmosphereVert);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, atmosphereFrag);
      if (!vs || !fs) {
        console.error('[Atmosphere] Shader compilation failed');
        return;
      }

      program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[Atmosphere] Program link failed:', gl.getProgramInfoLog(program));
        return;
      }

      const uniformNames = [
        'uInvVP', 'uCameraPos', 'uPlanetCenter', 'uPlanetRadius',
        'uAtmosphereRadius', 'uSunDirection', 'uTime',
      ];
      for (const name of uniformNames) {
        uniforms[name] = gl.getUniformLocation(program, name);
      }

      const quadVerts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      quadBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

      posLoc = gl.getAttribLocation(program, 'aPosition');
      console.log('[Atmosphere] Initialized');
    },

    render(gl: WebGLRenderingContext, args: any) {
      if (!program) return;

      const mainMatrix: number[] = args?.defaultProjectionData?.mainMatrix;
      if (!mainMatrix || mainMatrix.length !== 16) return;

      const vp = new Float32Array(mainMatrix);
      const invVP = invertMatrix4(vp);
      if (!invVP) return;

      const transform = (args as any).transform;
      const cameraPos = transform?.cameraPosition || [0, 0, 50000000];

      const now = Date.now() / 1000;
      const sunAzimuth = (now * 0.01) % (Math.PI * 2);
      const sunElevation = 0.3 + Math.sin(now * 0.005) * 0.2;
      const sunDir = [
        Math.cos(sunAzimuth) * Math.cos(sunElevation),
        Math.sin(sunElevation),
        Math.sin(sunAzimuth) * Math.cos(sunElevation),
      ];

      const planetRadius = EARTH_RADIUS_M;
      const atmosphereRadius = planetRadius * 1.015;

      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.uInvVP, false, invVP);
      gl.uniform3f(uniforms.uCameraPos, cameraPos[0], cameraPos[1], cameraPos[2]);
      gl.uniform3f(uniforms.uPlanetCenter, 0, 0, 0);
      gl.uniform1f(uniforms.uPlanetRadius, planetRadius);
      gl.uniform1f(uniforms.uAtmosphereRadius, atmosphereRadius);
      gl.uniform3f(uniforms.uSunDirection, sunDir[0], sunDir[1], sunDir[2]);
      gl.uniform1f(uniforms.uTime, now);

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.ALWAYS);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.depthFunc(gl.LESS);
      gl.disableVertexAttribArray(posLoc);
    },

    onRemove() {},
  };
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
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
