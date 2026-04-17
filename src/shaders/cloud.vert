// cloud.vert — Pass world position to fragment shader for ray marching
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uCloudBase;
uniform float uCloudTop;

varying vec3 vWorldPosition;
varying vec3 vObjectPosition;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  vObjectPosition = position;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
