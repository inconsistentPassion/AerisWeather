/**
 * Globe — Earth sphere with procedural PBR textures.
 * Color, normal, roughness, and metalness maps.
 * Oceans are shiny, land is matte, ice caps are slightly reflective.
 */

import * as THREE from 'three';

export const GLOBE_RADIUS = 6371; // km, arbitrary units

export function createGlobe(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

  // Procedural Earth-like textures
  const colorMap = generateEarthTexture(2048, 1024);
  const normalMap = generateNormalMap(1024, 512);
  const roughnessMap = generateRoughnessMap(1024, 512);
  const metalnessMap = generateMetalnessMap(512, 256);

  const material = new THREE.MeshStandardMaterial({
    map: colorMap,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughnessMap: roughnessMap,
    roughness: 0.8, // base roughness (overridden by map)
    metalnessMap: metalnessMap,
    metalness: 0.0, // base metalness (overridden by map)
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe';

  return mesh;
}

/**
 * Shared land detection — same algorithm across all maps.
 */
function isLand(lon: number, lat: number): boolean {
  const n1 = Math.sin(lon * 3.0 + 1.0) * Math.cos(lat * 2.5 - 0.3);
  const n2 = Math.sin(lon * 5.0 - 2.0) * Math.cos(lat * 4.0 + 1.0) * 0.5;
  const n3 = Math.sin(lon * 1.7 + 3.0) * Math.cos(lat * 1.3 + 0.7) * 0.3;
  return (n1 + n2 + n3) > 0.15;
}

/**
 * Procedural Earth-like color texture.
 * Blue oceans, green/brown landmasses, white polar caps.
 */
function generateEarthTexture(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const land = isLand(lon, lat);
      const absLat = Math.abs(lat);

      if (absLat > 1.3) {
        // Polar caps — white/blue-white
        const ice = 220 + Math.sin(lon * 5) * 10;
        data[idx] = ice; data[idx + 1] = ice + 5; data[idx + 2] = ice + 15;
      } else if (land) {
        // Land — green/brown with variation
        const green = 80 + Math.sin(lat * 2) * 30 + Math.cos(lon * 7) * 15;
        const brown = 60 + Math.cos(lon * 3) * 20;
        data[idx] = brown + 40; data[idx + 1] = green + 30; data[idx + 2] = brown;
      } else {
        // Ocean — deep blue with subtle wave pattern
        const depth = 15 + Math.sin(lon * 2 + lat) * 8 + Math.sin(lon * 10 + lat * 5) * 3;
        data[idx] = depth; data[idx + 1] = depth + 35; data[idx + 2] = depth + 85;
      }
      data[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/**
 * Normal map for surface detail — bumps on land, wave patterns on ocean.
 */
function generateNormalMap(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const land = isLand(lon, lat);

      // Land: more surface detail
      // Ocean: subtle wave normals
      const scale = land ? 0.15 : 0.05;
      const nx = Math.sin(x * scale) * Math.cos(y * scale * 0.8) * 25;
      const nz = Math.cos(x * scale * 0.9) * Math.sin(y * scale) * 25;

      data[idx] = 128 + nx;       // X normal
      data[idx + 1] = 255;        // Y normal (up)
      data[idx + 2] = 128 + nz;   // Z normal
      data[idx + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Roughness map: oceans are smooth/shiny (low roughness),
 * land is rough/matte (high roughness), ice is medium.
 */
function generateRoughnessMap(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const land = isLand(lon, lat);
      const absLat = Math.abs(lat);

      let roughness: number;

      if (absLat > 1.3) {
        // Polar ice — slightly rough
        roughness = 0.4;
      } else if (land) {
        // Land — rough/matte with variation
        roughness = 0.7 + Math.sin(lon * 3 + lat * 2) * 0.15;
      } else {
        // Ocean — smooth/shiny, with wave pattern variation
        const waveNoise = Math.sin(lon * 15 + lat * 10) * 0.05;
        roughness = 0.1 + waveNoise;
      }

      const val = Math.floor(Math.max(0, Math.min(1, roughness)) * 255);
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Metalness map: oceans have slight specular (metalness 0.05),
 * land and ice are non-metallic.
 */
function generateMetalnessMap(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const lat = (y / h) * Math.PI - Math.PI / 2;
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2 - Math.PI;
      const idx = (y * w + x) * 4;
      const land = isLand(lon, lat);

      // Only ocean has slight metalness for specular reflection
      const metalness = land ? 0.0 : 0.05;
      const val = Math.floor(metalness * 255);
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}
