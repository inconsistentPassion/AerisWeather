// cloud.frag — Ray-marched volumetric clouds with weather-driven density
//
// Improvements over v1:
//   - Multi-octave noise sampling (3 scales for detail hierarchy)
//   - Wind-driven noise animation
//   - Detail erosion using worley noise channel
//   - Silver lining (rim light) for backlit clouds
//   - Adaptive step size based on density
//   - Beer-Lambert + powder effect for thick clouds

#define PI 3.14159265359
#define MAX_STEPS 64
#define MAX_LIGHT_STEPS 12

uniform sampler2D uCloudMap;        // lat-lon cloud coverage (R=coverage, G=humidity, B=type)
uniform sampler3D uNoiseTex;        // 3D Perlin-Worley noise texture

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

uniform vec2 uWindVelocity;        // (u, v) wind in lat-lon for noise drift

varying vec3 vWorldPosition;

// --- Phase functions ---

float henyeyGreenstein(float cosTheta, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// Dual-lobe phase: forward scattering (silver lining) + back scattering
float dualLobePhase(float cosTheta) {
  float forward = henyeyGreenstein(cosTheta, 0.7);
  float back = henyeyGreenstein(cosTheta, -0.4);
  return mix(back, forward, 0.65);
}

// Powder effect: thick clouds scatter more light at edges
float powder(float density) {
  return 1.0 - exp(-density * 2.0);
}

// --- Coordinate transforms ---

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

// --- Weather map sampling ---

vec3 sampleWeatherMap(vec3 worldPos) {
  vec2 uv = worldToLatLon(worldPos);
  vec3 data = texture(uCloudMap, uv).rgb;
  return vec3(
    data.r * uCoverageMultiplier,  // coverage
    data.g,                         // humidity
    data.b                          // cloud type
  );
}

// --- Multi-octave noise sampling ---

float sampleNoiseOctave(vec3 pos, float scale, float speed) {
  vec3 uv = pos * scale + vec3(
    uTime * uWindVelocity.x * speed,
    0.0,
    uTime * uWindVelocity.y * speed
  );
  uv = fract(uv);
  return texture(uNoiseTex, uv).r;
}

// Sample all 4 channels of the noise texture at a given scale
vec4 sampleNoiseChannels(vec3 pos, float scale) {
  vec3 uv = pos * scale + vec3(
    uTime * uWindVelocity.x * 0.001,
    0.0,
    uTime * uWindVelocity.y * 0.001
  );
  uv = fract(uv);
  return texture(uNoiseTex, uv);
}

// Multi-channel noise: uses R for base, G for detail, B for erosion
float sampleNoise3D(vec3 worldPos) {
  // Sample at large scale — base cloud shape (R channel)
  vec4 largeNoise = sampleNoiseChannels(worldPos, 0.0003);
  float base = largeNoise.r; // Perlin-Worley combined

  // Sample at medium scale — billowy detail (R channel, different scale)
  vec4 medNoise = sampleNoiseChannels(worldPos, 0.001);
  float medium = medNoise.r;

  // Sample detail noise — fine erosion (G channel = detail Perlin FBM)
  vec4 detailNoise = sampleNoiseChannels(worldPos, 0.004);
  float detail = detailNoise.g; // Detail Perlin FBM

  // Worley erosion — sharpens edges (B channel = Worley FBM)
  float erosion = detailNoise.b;

  // Combine: base shape + medium detail, eroded by worley
  float shape = base * 0.5 + medium * 0.3 + detail * 0.2;

  // Erode edges using worley noise
  shape *= (0.6 + 0.4 * erosion);

  return shape;
}

// --- Height profiles ---

// Stratus: low, flat, widespread
float stratusProfile(float h) {
  return smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.15, 0.35, h)) * 0.5;
}

// Cumulus: puffy, mid-altitude, the main clouds
float cumulusProfile(float h) {
  return smoothstep(0.05, 0.2, h) * (1.0 - smoothstep(0.5, 0.8, h)) * 1.0;
}

// Cumulonimbus: tall, extends high, dramatic
float cumulonimbusProfile(float h) {
  return smoothstep(0.1, 0.3, h) * (1.0 - smoothstep(0.8, 1.0, h)) * 1.2;
}

// Cirrus: thin, wispy, high altitude
float cirrusProfile(float h) {
  return smoothstep(0.6, 0.75, h) * (1.0 - smoothstep(0.9, 1.0, h)) * 0.25;
}

float heightProfile(float altitude, float cloudType) {
  float cloudRange = uCloudTop - uCloudBase;
  float h = (altitude - uCloudBase) / cloudRange;

  // Blend profiles based on cloud type from weather data
  float s = stratusProfile(h);
  float cu = cumulusProfile(h);
  float cb = cumulonimbusProfile(h);
  float ci = cirrusProfile(h);

  // cloudType: 0=mostly stratus, 0.5=cumulus, 1.0=cirrus
  // Use it to weight the profiles
  float stratusWeight = 1.0 - smoothstep(0.0, 0.4, cloudType);
  float cumulusWeight = 1.0 - abs(cloudType - 0.5) * 2.0;
  float cirrusWeight = smoothstep(0.6, 1.0, cloudType);

  return s * stratusWeight + cu * cumulusWeight + ci * cirrusWeight + cb * 0.3;
}

// --- Density sampling ---

float sampleDensity(vec3 worldPos) {
  vec3 rel = worldPos - uPlanetCenter;
  float r = length(rel);
  float altitude = r - uPlanetRadius;

  if (altitude < uCloudBase || altitude > uCloudTop) return 0.0;

  // Weather data
  vec3 weather = sampleWeatherMap(worldPos);
  float coverage = weather.x;
  float humidity = weather.y;
  float cloudType = weather.z;

  // Multi-octave noise
  float noise = sampleNoise3D(worldPos);

  // Height shaping
  float hProfile = heightProfile(altitude, cloudType);

  // Density = coverage × humidity × height × noise
  float density = coverage * humidity * hProfile * noise;

  // Sharpen edges (density remapping)
  density = smoothstep(0.05, 0.5, density);

  return density * uDensityMultiplier;
}

// Soft density for light marching (reduces cost)
float sampleDensitySoft(vec3 worldPos) {
  vec3 rel = worldPos - uPlanetCenter;
  float r = length(rel);
  float altitude = r - uPlanetRadius;

  if (altitude < uCloudBase || altitude > uCloudTop) return 0.0;

  vec3 weather = sampleWeatherMap(worldPos);
  float coverage = weather.x;

  // Only sample large-scale noise for light march
  float noise = sampleNoiseOctave(worldPos, 0.0003, 0.0008);
  float hProfile = cumulusProfile((altitude - uCloudBase) / (uCloudTop - uCloudBase));

  float density = coverage * hProfile * noise;
  density = smoothstep(0.1, 0.5, density);

  return density * uDensityMultiplier;
}

// --- Ray-sphere intersection ---

vec2 intersectSphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float disc = b * b - c;

  if (disc < 0.0) return vec2(-1.0);

  float sqrtDisc = sqrt(disc);
  return vec2(-b - sqrtDisc, -b + sqrtDisc);
}

// --- Main ray march ---

void main() {
  vec3 ro = uCameraPosition;
  vec3 rd = normalize(vWorldPosition - uCameraPosition);

  // Cloud shell intersections
  vec2 innerHit = intersectSphere(ro - uPlanetCenter, rd, uCloudBase);
  vec2 outerHit = intersectSphere(ro - uPlanetCenter, rd, uCloudTop);

  float tStart = max(0.0, outerHit.x);
  float tEnd = outerHit.y;

  if (tStart < 0.0 && tEnd < 0.0) discard;

  // Don't march through earth
  if (innerHit.x > 0.0 && innerHit.y > 0.0) {
    tEnd = min(tEnd, innerHit.x);
  }
  tStart = max(tStart, 0.0);

  // Blue noise dither to reduce banding
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  tStart += dither * (tEnd - tStart) / float(uMaxSteps);

  // Ray marching
  float transmittance = 1.0;
  vec3 lightEnergy = vec3(0.0);
  float totalDensity = 0.0;

  float marchRange = tEnd - tStart;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uMaxSteps) break;
    if (transmittance < 0.005) break;

    // Adaptive step: base step + density-based refinement
    float tNorm = float(i) / float(uMaxSteps);
    float t = tStart + marchRange * pow(tNorm, 1.3); // slight bias toward camera

    vec3 pos = ro + rd * t;
    float density = sampleDensity(pos);

    if (density > 0.001) {
      float stepSize = marchRange / float(uMaxSteps);
      // Larger steps in low density, smaller in dense regions
      stepSize *= mix(1.5, 0.5, smoothstep(0.0, 0.1, density));

      float sampleExtinction = density * stepSize;
      float sampleTransmittance = exp(-sampleExtinction);

      // --- Lighting ---
      // Light march through the cloud to estimate shadow
      float lightDensity = 0.0;
      float lightStep = 300.0; // step size for light ray

      for (int j = 0; j < MAX_LIGHT_STEPS; j++) {
        vec3 lightPos = pos + uSunDirection * float(j) * lightStep;
        lightDensity += sampleDensitySoft(lightPos);
      }

      float lightTransmittance = exp(-lightDensity * 0.25);
      float powderTerm = powder(totalDensity + sampleExtinction);

      // Phase function
      float cosTheta = dot(rd, uSunDirection);
      float pf = dualLobePhase(cosTheta);

      // Silver lining: bright rim when sun is behind cloud
      float silverLining = 0.0;
      if (cosTheta < -0.3) {
        silverLining = pow(max(0.0, -cosTheta - 0.3) / 0.7, 3.0) * 0.5;
      }

      // Scattered light
      vec3 scatterColor = uSunColor * (lightTransmittance * pf + silverLining);
      scatterColor *= powderTerm;

      // Ambient light from sky (blue-ish)
      vec3 ambientColor = vec3(0.3, 0.4, 0.6) * 0.15;

      lightEnergy += transmittance * sampleExtinction * (scatterColor + ambientColor);
      transmittance *= sampleTransmittance;
      totalDensity += sampleExtinction;
    }
  }

  // Cloud alpha
  float alpha = 1.0 - transmittance;

  // Soften very thin clouds
  alpha = smoothstep(0.0, 0.05, alpha);

  gl_FragColor = vec4(lightEnergy, alpha);
}
