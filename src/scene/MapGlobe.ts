/**
 * MapGlobe — MapLibre GL JS globe with Three.js cloud overlay.
 *
 * MapLibre handles: tiles, zoom, globe projection, camera, atmosphere.
 * Three.js handles: volumetric clouds (rendered as a MapLibre custom layer).
 *
 * The two share the same WebGL2 context via MapLibre's custom layer API,
 * which provides native GL matrices for perfect overlay alignment.
 */

import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { CloudRenderer } from '../clouds/CloudRenderer';
import { WeatherManager } from '../weather/WeatherManager';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

export interface MapGlobeHandle {
  map: maplibregl.Map;
  weather: WeatherManager;
  /** Cloud renderer — available after map loads */
  clouds: CloudRenderer | null;
  /** Promise that resolves when map is fully loaded */
  ready: Promise<void>;
}

export function createMapGlobe(container: HTMLElement): MapGlobeHandle {
  const weather = new WeatherManager();
  let cloudRenderer: CloudRenderer | null = null;

  // ── MapLibre map ───────────────────────────────────────────────────
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: [0, 20],
    zoom: 2.5,
    pitch: 49,
    bearing: -20,
    maxPitch: 80,
    attributionControl: false,
    cancelPendingTileRequestsWhileZooming: true,
    maxTileCacheZoomLevels: 4,
    renderWorldCopies: false,
  });

  // ── Globe projection + atmosphere sky ──────────────────────────────
  map.on('style.load', () => {
    (map as any).setStyle(map.getStyle(), {
      transformStyle: (_prev: any, next: any) => {
        next.projection = { type: 'globe' };
        if (!next.sky) {
          next.sky = {
            'atmosphere-blend': [
              'interpolate', ['linear'], ['zoom'],
              0, 1,
              5, 0.3,
              8, 0,
            ],
          };
        }
        return next;
      },
    });

    map.once('style.load', () => {
      try { (map as any).setProjection({ type: 'globe' }); } catch { /* noop */ }
    });
  });

  // ── Ready promise ──────────────────────────────────────────────────
  const ready = new Promise<void>((resolve) => {
    map.on('load', () => resolve());
  });

  // ── Three.js custom layer for volumetric clouds ────────────────────
  const cloudLayer: maplibregl.CustomLayerInterface = {
    id: 'three-clouds',
    type: 'custom',
    renderingMode: '3d',

    onAdd(_mapInstance: maplibregl.Map, gl: WebGLRenderingContext) {
      // Three.js renderer sharing MapLibre's GL context
      const renderer = new THREE.WebGLRenderer({
        canvas: _mapInstance.getCanvas(),
        context: gl,
        antialias: true,
        alpha: true,
      });
      renderer.autoClear = false; // Don't clear MapLibre's framebuffer
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      // Scene with no visible globe (MapLibre draws the earth)
      const scene = new THREE.Scene();

      // Camera — will be synced with MapLibre's matrices each frame
      const camera = new THREE.PerspectiveCamera();

      // Cloud parent object — invisible anchor for cloud mesh
      const cloudParent = new THREE.Object3D();
      scene.add(cloudParent);

      // Create cloud renderer
      cloudRenderer = new CloudRenderer(cloudParent, weather);

      // Lighting for cloud shading
      const sun = new THREE.DirectionalLight(0xfff5e0, 1.2);
      sun.position.set(1, 0.5, -0.3);
      scene.add(sun);
      scene.add(new THREE.AmbientLight(0xffffff, 0.3));

      // Store refs for render callback
      (this as any)._renderer = renderer;
      (this as any)._scene = scene;
      (this as any)._camera = camera;
      (this as any)._cloudParent = cloudParent;
    },

    render(_gl: WebGLRenderingContext, args: any) {
      const renderer: THREE.WebGLRenderer = (this as any)._renderer;
      const scene: THREE.Scene = (this as any)._scene;
      const camera: THREE.PerspectiveCamera = (this as any)._camera;
      const cloudParent: THREE.Object3D = (this as any)._cloudParent;

      if (!renderer || !scene || !camera) return;

      // ── Sync camera with MapLibre's native GL matrices ────────────
      // MapLibre provides the combined view-projection matrix in
      // column-major format (same as Three.js/OpenGL convention).
      const mainMatrix: number[] = args?.defaultProjectionData?.mainMatrix;

      if (mainMatrix && mainMatrix.length === 16) {
        // Apply the combined VP matrix directly
        camera.projectionMatrix.fromArray(mainMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

        // Set camera at origin — the VP matrix encodes the full transform
        camera.position.set(0, 0, 0);
        camera.quaternion.identity();
        camera.scale.set(1, 1, 1);
        camera.updateMatrixWorld(true);
      }

      // ── Update clouds ─────────────────────────────────────────────
      const now = performance.now() * 0.001;

      // Slow cloud rotation (wind drift simulation)
      cloudParent.rotation.y = now * 0.008;

      if (cloudRenderer) {
        cloudRenderer.update(1 / 60, { threeCamera: camera });
      }

      // ── Render Three.js on top of MapLibre ────────────────────────
      // Reset GL state that MapLibre may have changed
      renderer.state.reset();
      renderer.render(scene, camera);
    },

    onRemove() {
      const renderer: THREE.WebGLRenderer = (this as any)._renderer;
      if (renderer) renderer.dispose();
    },
  };

  // Register custom layer after map loads
  map.on('load', () => {
    map.addLayer(cloudLayer);
  });

  return {
    map,
    weather,
    get clouds() { return cloudRenderer; },
    ready,
  };
}
