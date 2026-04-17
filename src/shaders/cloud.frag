// cloud.frag — Ray-marched volumetric clouds with weather-driven density
//
// Key concepts:
//   - Ray march through cloud shell (between cloudBase and cloudTop)
//   - Sample 3D noise for structure + 2D cloud map for coverage
//   - Beer-Lambert transmittance + Henyey-Greenstein phase function
//   - Logarithmic step distribution (more samples near camera)

#define PI 3.14159265359
#define MAX_STEPS 64
#define MAX_LIGHT_STEPS 12

uniform sampler2D uCloudMap;        // lat-lon cloud coverage
uniform sampler3D uNoiseTex;        // 3D noise texture

uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uCloudBase;
uniform float uCloudTop;

uniform float uTime;
uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;

uniform int uMaxSteps;
uniform int uLightSteps;
uniform float uDensityMultiplier;
uniform float uCoverageMultiplier;

varying vec3 vWorldPosition;

// Henyey-Greenstein phase function
float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Dual-lobe phase function (forward + back scattering)
float phase(float cosTheta) {
  float hg1 = henyeyGreenstein(cosTheta, 0.8);   // forward
  float hg2 = henyeyGreenstein(cosTheta, -0.3);  // back
  return mix(hg2, hg1, 0.7);
}

// Convert world position to lat-lon UV on the cloud map
vec2 worldToLatLon(vec3 worldPos) {
  vec3 rel = worldPos - uPlanetCenter;
  float r = length(rel);
  vec3 n = rel / r;

  float lat = asin(clamp(n.y, -1.0, 1.0));
  float lon = atan(n.z, n.x);

  return vec2(
    (lon / (2.0 * PI)) + 0.5,
    (lat / PI) + 0.5
  );
}

// Sample cloud coverage from the 2D weather map
float sampleCoverage(vec3 worldPos) {
  vec2 uv = worldToLatLon(worldPos);
  float coverage = texture(uCloudMap, uv).r;
  return coverage * uCoverageMultiplier;
}

// Sample 3D noise at world position (with tiling)
float sampleNoise(vec3 worldPos) {
  vec3 noiseUV = worldPos * 0.0004 + vec3(uTime * 0.001, 0.0, uTime * 0.0005);
  noiseUV = fract(noiseUV); // tile
  return texture(uNoiseTex, noiseUV).r;
}

// Height profile for cloud shape (stratus at base, cumulus in middle, cirrus at top)
float heightProfile(float altitude) {
  float cloudRange = uCloudTop - uCloudBase;
  float normalizedAlt = (altitude - uCloudBase) / cloudRange;

  // Stratus layer near base
  float stratus = smoothstep(0.0, 0.15, normalizedAlt) * (1.0 - smoothstep(0.15, 0.35, normalizedAlt)) * 0.6;

  // Cumulus in mid-levels (the main clouds)
  float cumulus = smoothstep(0.1, 0.3, normalizedAlt) * (1.0 - smoothstep(0.6, 0.85, normalizedAlt)) * 1.0;

  // Cirrus wisps near top
  float cirrus = smoothstep(0.6, 0.8, normalizedAlt) * (1.0 - smoothstep(0.9, 1.0, normalizedAlt)) * 0.3;

  return stratus + cumulus + cirrus;
}

// Sample full density at a point
float sampleDensity(vec3 worldPos) {
  vec3 rel = worldPos - uPlanetCenter;
  float r = length(rel);
  float altitude = r - uPlanetRadius;

  // Outside cloud shell → no density
  if (altitude < uCloudBase || altitude > uCloudTop) return 0.0;

  float coverage = sampleCoverage(worldPos);
  float noise = sampleNoise(worldPos);
  float hProfile = heightProfile(altitude);

  // Density = coverage × height_shape × noise
  float density = coverage * hProfile * noise;

  // Remap noise to create sharper edges (use worley for erosion in production)
  density = smoothstep(0.1, 0.6, density);

  return density * uDensityMultiplier;
}

// Find ray-sphere intersection for cloud shell
vec2 intersectSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;

  if (disc < 0.0) return vec2(-1.0);

  float sqrtDisc = sqrt(disc);
  return vec2(-b - sqrtDisc, -b + sqrtDisc);
}

// Ray march through cloud volume
void main() {
  vec3 ro = uCameraPosition;
  vec3 rd = normalize(vWorldPosition - uCameraPosition);

  // Intersect ray with inner and outer cloud shells
  vec2 innerHit = intersectSphere(ro - uPlanetCenter, rd, uCloudBase);
  vec2 outerHit = intersectSphere(ro - uPlanetCenter, rd, uCloudTop);

  // Determine march range
  float tStart = max(0.0, outerHit.x);
  float tEnd = outerHit.y;

  // If ray doesn't hit outer shell, skip
  if (tStart < 0.0 && tEnd < 0.0) {
    discard;
  }

  // Clamp to inner shell (don't march through earth)
  if (innerHit.x > 0.0 && innerHit.y > 0.0) {
    tEnd = min(tEnd, innerHit.x);
  }

  tStart = max(tStart, 0.0);

  // Ray marching
  float transmittance = 1.0;
  vec3 lightEnergy = vec3(0.0);

  // Blue noise dithering offset (should use a noise texture in production)
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  tStart += dither * (tEnd - tStart) / float(uMaxSteps);

  // Logarithmic step distribution
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uMaxSteps) break;
    if (transmittance < 0.01) break; // nearly opaque

    // Logarithmic distribution: more steps near camera
    float t = tStart + (tEnd - tStart) * pow(float(i) / float(uMaxSteps), 1.5);
    vec3 pos = ro + rd * t;

    float density = sampleDensity(pos);

    if (density > 0.001) {
      float stepSize = (tEnd - tStart) / float(uMaxSteps) * pow(1.5, float(i) / float(uMaxSteps));
      float sampleTransmittance = exp(-density * stepSize);

      // Light march: how much light reaches this point?
      vec3 lightDir = uSunDirection;
      float lightDensity = 0.0;

      for (int j = 0; j < MAX_LIGHT_STEPS; j++) {
        vec3 lightPos = pos + lightDir * float(j) * 200.0; // light step size
        lightDensity += sampleDensity(lightPos);
      }

      float lightTransmittance = exp(-lightDensity * 0.3);
      float cosTheta = dot(rd, lightDir);
      float pf = phase(cosTheta);

      vec3 scatterColor = uSunColor * lightTransmittance * pf;
      lightEnergy += transmittance * density * stepSize * scatterColor;
      transmittance *= sampleTransmittance;
    }
  }

  gl_FragColor = vec4(lightEnergy, 1.0 - transmittance);
}
