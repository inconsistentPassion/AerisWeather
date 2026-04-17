/**
 * Globe — Earth sphere with procedural color + normal maps.
 */

import * as THREE from 'three';

export const GLOBE_RADIUS = 6371; // km, arbitrary units

export function createGlobe(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(GLOBE_RADIUS, 256, 256);

  // Procedural Earth-like textures
  const colorMap = generateEarthTexture(2048, 1024);
  const normalMap = generateNormalMap(1024, 512);

  const material = new THREE.MeshStandardMaterial({
    map: colorMap,
    normalMap: normalMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughness: 0.85,
    metalness: 0.05,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'globe';

  return mesh;
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

      // Simple continent noise
      const n1 = Math.sin(lon * 3.0 + 1.0) * Math.cos(lat * 2.5 - 0.3);
      const n2 = Math.sin(lon * 5.0 - 2.0) * Math.cos(lat * 4.0 + 1.0) * 0.5;
      const n3 = Math.sin(lon * 1.7 + 3.0) * Math.cos(lat * 1.3 + 0.7) * 0.3;
      const land = (n1 + n2 + n3) > 0.15;

      const absLat = Math.abs(lat);

      if (absLat > 1.3) {
        // Polar caps — white
        data[idx] = 230; data[idx + 1] = 235; data[idx + 2] = 240;
      } else if (land) {
        // Land — green/brown
        const green = 80 + Math.sin(lat * 2) * 30;
        const brown = 60 + Math.cos(lon * 3) * 20;
        data[idx] = brown + 40; data[idx + 1] = green + 30; data[idx + 2] = brown;
      } else {
        // Ocean — deep blue
        const depth = 20 + Math.sin(lon * 2 + lat) * 10;
        data[idx] = depth; data[idx + 1] = depth + 30; data[idx + 2] = depth + 80;
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

function generateNormalMap(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      data[idx] = Math.sin(x * 0.1) * Math.cos(y * 0.15) * 20 + 128;
      data[idx + 1] = 255;
      data[idx + 2] = Math.cos(x * 0.12) * Math.sin(y * 0.1) * 20 + 128;
      data[idx + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}
