// cloud.vert — Fullscreen quad for ray-marched volumetric clouds
//
// Renders a screen-aligned quad. The fragment shader ray-marches
// through a cloud shell around the earth using MapLibre's native
// view-projection matrices.

precision highp float;

// Fullscreen quad — two triangles
// position: [-1,-1] to [1,1]
attribute vec2 aPosition;

// Inverse view-projection matrix (from MapLibre)
uniform mat4 uInvVP;

varying vec3 vRayDir;
varying vec2 vUV;

void main() {
  // UV coordinates [0,1]
  vUV = aPosition * 0.5 + 0.5;

  // Unproject the screen position to world-space ray direction
  // Points on the near plane (z=0 in NDC) and far plane (z=1 in NDC)
  vec4 nearPoint = uInvVP * vec4(aPosition, 0.0, 1.0);
  vec4 farPoint  = uInvVP * vec4(aPosition, 1.0, 1.0);

  nearPoint.xyz /= nearPoint.w;
  farPoint.xyz  /= farPoint.w;

  // Ray direction (not normalized — fragment shader will normalize)
  vRayDir = farPoint.xyz - nearPoint.xyz;

  gl_Position = vec4(aPosition, 0.0, 1.0);
}
