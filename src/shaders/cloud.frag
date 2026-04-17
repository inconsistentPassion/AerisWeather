// cloud.frag — Ray-marched volumetric clouds around a sphere
//
// Renders clouds by ray marching through a spherical shell.
// Uses 3D Perlin-Worley noise for cloud shapes.
// Designed for WebGL2 with MapLibre GL JS integration.

precision highp float;

#define PI 3.14159265359
#define MAX_STEPS 48
#define MAX_LIGHT_STEPS 4

uniform sampler2D uCloudMap;
uniform sampler3D uNoiseTex;

uniform vec3 uCameraPos;       // Camera world position (MapLibre scale)
uniform vec3 uPlanetCenter;    // Earth center (usually origin)
uniform float uPlanetRadius;   // 6371008.8 (MapLibre WGS84)
uniform float uCloudBaseAlt;   // Base altitude above surface (meters)
uniform float uCloudTopAlt;    // Top altitude above surface (meters)

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;

uniform float uDensityMult;
uniform float uCoverageMult;

varying vec3 vRayDir;
varying vec2 vUV;

// ── Phase functions ───────────────────────────────────────────────────

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

float cloudPhase(float cosTheta) {
  float forward = henyeyGreenstein(cosTheta, 0.6);
  float back    = henyeyGreenstein(cosTheta, -0.4);
  return mix(back, forward, 0.7);
}

// ── Coordinate mapping ────────────────────────────────────────────────

vec2 worldToUV(vec3 worldPos) {
  vec3 rel = normalize(worldPos - uPlanetCenter);
  float lat = asin(clamp(rel.y, -1.0, 1.0));
  float lon = atan(rel.z, rel.x);
  return vec2(
    (lon / (2.0 * PI)) + 0.5,
    (lat / PI) + 0.5
  );
}

// ── Cloud density function ────────────────────────────────────────────

float getDensity(vec3 pos) {
  vec3 rel = pos - uPlanetCenter;
  float r = length(rel);
  float altitude = r - uPlanetRadius;

  float cloudBase = uCloudBaseAlt;
  float cloudTop  = uCloudTopAlt;

  // Outside cloud shell
  if (altitude < cloudBase || altitude > cloudTop) return 0.0;

  // Height profile: 0 at base/top, 1 in the middle
  float cloudRange = cloudTop - cloudBase;
  float h = (altitude - cloudBase) / cloudRange;
  float heightShape = smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.6, 1.0, h));

  // Cloud coverage from weather map
  vec2 uv = worldToUV(pos);
  float coverage = texture(uCloudMap, uv).r * uCoverageMult;

  // 3D noise at two scales
  float noiseScale1 = 1.0 / 500000.0;  // Large structure
  float noiseScale2 = 1.0 / 100000.0;  // Detail

  vec3 noisePos = pos * noiseScale1 + vec3(uTime * 0.00002, 0.0, uTime * 0.000015);
  float n1 = texture(uNoiseTex, fract(noisePos)).r;

  vec3 noisePos2 = pos * noiseScale2 + vec3(uTime * 0.00005, 0.0, uTime * 0.00004);
  float n2 = texture(uNoiseTex, fract(noisePos2)).r;

  float noise = n1 * 0.6 + n2 * 0.4;

  // Density
  float density = coverage * heightShape * noise * uDensityMult;
  density = smoothstep(0.05, 0.5, density);

  return density;
}

// ── Ray-sphere intersection ───────────────────────────────────────────

vec2 hitSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// ── Main ──────────────────────────────────────────────────────────────

void main() {
  vec3 rd = normalize(vRayDir);
  vec3 ro = uCameraPos - uPlanetCenter;

  float cloudBaseR = uPlanetRadius + uCloudBaseAlt;
  float cloudTopR  = uPlanetRadius + uCloudTopAlt;

  // Intersect with cloud shell
  vec2 outerHit = hitSphere(ro, rd, cloudTopR);
  vec2 innerHit = hitSphere(ro, rd, cloudBaseR);

  if (outerHit.y < 0.0) {
    discard; // Cloud shell behind camera
  }

  float tNear = max(0.0, outerHit.x);
  float tFar = outerHit.y;

  // Don't march through the planet
  if (innerHit.x > 0.0) {
    tFar = min(tFar, innerHit.x);
  }

  if (tNear >= tFar) {
    discard;
  }

  // Blue noise dither to reduce banding
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  tNear += dither * (tFar - tNear) / float(MAX_STEPS);

  // Ray march
  float transmittance = 1.0;
  vec3 lightEnergy = vec3(0.0);
  float marchLen = tFar - tNear;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (transmittance < 0.01) break;

    float t = tNear + marchLen * (float(i) + 0.5) / float(MAX_STEPS);
    vec3 pos = uCameraPos + rd * t;

    float density = getDensity(pos);

    if (density > 0.001) {
      float stepLen = marchLen / float(MAX_STEPS);
      float extinction = density * stepLen;
      transmittance *= exp(-extinction);

      // Light march — sample density toward the sun
      float lightDensity = 0.0;
      for (int j = 0; j < MAX_LIGHT_STEPS; j++) {
        vec3 lp = pos + uSunDir * float(j + 1) * 3000.0;
        lightDensity += getDensity(lp) * 3000.0 * 0.5;
      }
      float lightTransmittance = exp(-lightDensity * 0.2);

      // Phase function
      float cosTheta = dot(rd, uSunDir);
      float pf = cloudPhase(cosTheta);

      // Silver lining at backscatter
      float silver = smoothstep(-0.5, -0.8, cosTheta) * 0.3;

      // Accumulate
      vec3 scatter = uSunColor * (lightTransmittance * pf + silver);
      vec3 ambient = vec3(0.25, 0.35, 0.5) * 0.15;
      lightEnergy += transmittance * extinction * (scatter + ambient);
    }
  }

  float alpha = 1.0 - transmittance;
  alpha = smoothstep(0.0, 0.05, alpha); // Soften thin edges

  if (alpha < 0.005) discard;

  gl_FragColor = vec4(lightEnergy, alpha * 0.85);
}
