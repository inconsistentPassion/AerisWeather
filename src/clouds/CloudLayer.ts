/**
 * CloudLayer — MapLibre custom layer that renders Three.js volumetric clouds.
 *
 * Uses MapLibre's custom layer API to share the WebGL context and
 * get native GL projection matrices. The Three.js CloudRenderer
 * draws ray-marched volumetric clouds on top of the globe.
 */

import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { CloudRenderer } from '../clouds/CloudRenderer';
import { WeatherManager } from '../weather/WeatherManager';

const EARTH_RADIUS = 6371008.8; // MapLibre's WGS84 radius in meters

export function createCloudLayer(weather: WeatherManager): maplibregl.CustomLayerInterface {
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let cloudParent: THREE.Object3D;
  let clouds: CloudRenderer;
  let sunLight: THREE.DirectionalLight;

  return {
    id: 'volumetric-clouds',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
      // Three.js renderer sharing MapLibre's GL context
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: false,
        alpha: true,
      });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      // Scene — no globe, just clouds
      scene = new THREE.Scene();

      // Camera — will be synced with MapLibre matrices each frame
      camera = new THREE.PerspectiveCamera();

      // Cloud parent — clouds rotate with this
      cloudParent = new THREE.Object3D();
      scene.add(cloudParent);

      // Create volumetric cloud renderer
      clouds = new CloudRenderer(cloudParent, weather);

      // Lighting for cloud shading
      sunLight = new THREE.DirectionalLight(0xfff5e0, 1.5);
      sunLight.position.set(1, 0.5, -0.3);
      scene.add(sunLight);
      scene.add(new THREE.AmbientLight(0x6688aa, 0.3));
    },

    render(gl: WebGLRenderingContext, args: any) {
      if (!renderer || !scene || !camera) return;

      // ── Sync camera with MapLibre's projection ────────────────────
      const projData = args?.defaultProjectionData;
      if (!projData) return;

      const vpMatrix: number[] = projData.mainMatrix;
      if (!vpMatrix || vpMatrix.length !== 16) return;

      // Apply MapLibre's combined view-projection matrix to Three.js camera
      camera.projectionMatrix.fromArray(vpMatrix);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      // Extract camera world position from inverse VP matrix
      // In globe mode, the camera orbits the earth at origin
      const invVP = camera.projectionMatrixInverse;
      const camPos = extractCameraPosition(invVP);
      camera.position.copy(camPos);
      camera.lookAt(0, 0, 0);

      // Compute up vector (perpendicular to look direction, pointing "up" in globe frame)
      const lookDir = new THREE.Vector3(0, 0, 0).sub(camPos).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      // Remove component along look direction
      const right = new THREE.Vector3().crossVectors(lookDir, up).normalize();
      camera.up.crossVectors(right, lookDir).normalize();
      camera.updateMatrixWorld(true);

      // ── Update clouds ─────────────────────────────────────────────
      clouds.update(1 / 60, { threeCamera: camera });

      // ── Render on top of MapLibre ─────────────────────────────────
      renderer.state.reset();
      renderer.render(scene, camera);
    },

    onRemove() {
      if (renderer) renderer.dispose();
    },
  };
}

/**
 * Extract camera world position from an inverse view-projection matrix.
 *
 * The camera in view space is at (0,0,0). To find its world-space position,
 * transform (0,0,0,1) through the inverse VP matrix and perspective-divide.
 */
function extractCameraPosition(invVP: THREE.Matrix4): THREE.Vector3 {
  // Transform the origin of view space through invVP
  const v = new THREE.Vector4(0, 0, 0, 1);
  v.applyMatrix4(invVP);

  if (Math.abs(v.w) > 1e-6) {
    return new THREE.Vector3(v.x / v.w, v.y / v.w, v.z / v.w);
  }

  // Fallback: derive from MapLibre view state
  return new THREE.Vector3(0, EARTH_RADIUS * 2, 0);
}
