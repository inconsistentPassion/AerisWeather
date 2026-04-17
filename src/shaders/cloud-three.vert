// cloud-three.vert — Three.js vertex shader (GLSL 100)
// Three.js provides modelMatrix, projectionMatrix, viewMatrix as builtins.

uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uCloudBase;
uniform float uCloudTop;

varying vec3 vWorldPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
