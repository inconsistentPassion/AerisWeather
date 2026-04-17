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

export function createCloudLayer(weather: WeatherManager): maplibregl.CustomLayerInterface {
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let cloudParent: THREE.Object3D;
  let clouds: CloudRenderer;
  let _cameraMatrix = new THREE.Matrix4();
  let _cameraPos = new THREE.Vector3();
  let _cameraQuat = new THREE.Quaternion();

  return {
    id: 'volumetric-clouds',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext) {
      // Three.js renderer sharing MapLibre's GL context
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl as WebGL2RenderingContext,
        antialias: false,
        alpha: true,
      });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      scene = new THREE.Scene();

      camera = new THREE.PerspectiveCamera();

      // Cloud parent — positioned at earth center
      cloudParent = new THREE.Object3D();
      scene.add(cloudParent);

      clouds = new CloudRenderer(cloudParent, weather);

      // Lighting for cloud shading
      const sunLight = new THREE.DirectionalLight(0xfff5e0, 1.5);
      sunLight.position.set(1, 0.5, -0.3);
      scene.add(sunLight);
      scene.add(new THREE.AmbientLight(0x6688aa, 0.3));
    },

    render(gl: WebGLRenderingContext, args: any) {
      if (!renderer || !scene || !camera) return;

      const projData = args?.defaultProjectionData;
      if (!projData) return;

      const vpMatrix: number[] = projData.mainMatrix;
      if (!vpMatrix || vpMatrix.length !== 16) return;

      // ── Extract camera from MapLibre's VP matrix ──────────────────
      //
      // The VP matrix maps world coords → clip space.
      // VP = Projection * View
      // inv(VP) = inv(View) * inv(Projection)
      // The camera's world transform (inv(View)) is embedded in inv(VP).
      //
      // We extract the camera basis vectors from inv(VP):
      //   Row 0 (x-axis) → right vector
      //   Row 1 (y-axis) → up vector
      //   Row 2 (z-axis) → forward vector
      //   Row 3 → camera position (after perspective divide)
      //
      const invVP = new THREE.Matrix4();
      invVP.fromArray(vpMatrix);
      invVP.invert();

      // Camera position: transform origin through inv(VP)
      const v = new THREE.Vector4(0, 0, 0, 1).applyMatrix4(invVP);
      if (Math.abs(v.w) > 1e-6) {
        _cameraPos.set(v.x / v.w, v.y / v.w, v.z / v.w);
      } else {
        // Fallback: place camera above north pole
        _cameraPos.set(0, 12742000, 0);
      }

      // Build camera world matrix from inv(VP) basis vectors
      // MapLibre uses OpenGL convention: camera looks along -Z
      // Three.js convention: camera also looks along -Z (same!)
      // So we can use the inv(VP) basis vectors directly.
      //
      // invVP in column-major [col0, col1, col2, col3]:
      //   col0 = right direction + some projection info
      //   col1 = up direction + some projection info
      //   col2 = -forward direction + some projection info
      //   col3 = camera position (in projective space)
      //
      // For the rotation, we need the upper-left 3x3 of the
      // camera's world matrix (inv(View)).

      // Extract direction vectors from inv(VP) rows
      // Row 0: [invVP[0], invVP[4], invVP[8]]
      // Row 1: [invVP[1], invVP[5], invVP[9]]
      // Row 2: [invVP[2], invVP[6], invVP[10]]
      const right = new THREE.Vector3(invVP.elements[0], invVP.elements[4], invVP.elements[8]);
      const up = new THREE.Vector3(invVP.elements[1], invVP.elements[5], invVP.elements[9]);
      const fwd = new THREE.Vector3(invVP.elements[2], invVP.elements[6], invVP.elements[10]);

      // Build rotation matrix (pure rotation, no translation)
      // makeBasis takes column vectors, Three.js convention: +Z = back
      // inv(VP) rows: right(+X), up(+Y), -fwd(-Z → maps to Three.js camera +Z = back)
      const rotMat = new THREE.Matrix4();
      rotMat.makeBasis(right, up, fwd.clone().negate());

      // Build full camera world matrix: translation * rotation
      _cameraMatrix.identity();
      _cameraMatrix.makeTranslation(_cameraPos.x, _cameraPos.y, _cameraPos.z);
      _cameraMatrix.multiply(rotMat);

      // Decompose to get position and quaternion
      _cameraMatrix.decompose(_cameraPos, _cameraQuat, new THREE.Vector3());

      // Apply to Three.js camera
      camera.position.copy(_cameraPos);
      camera.quaternion.copy(_cameraQuat);
      camera.scale.set(1, 1, 1);
      camera.updateMatrixWorld(true);

      // Override projection matrix with MapLibre's exact projection
      // Prevents Three.js from recomputing from fov/near/far
      const projArr = args.projectionMatrix || vpMatrix;
      camera.projectionMatrix.fromArray(projArr);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      // ── Update clouds ─────────────────────────────────────────────
      clouds.update(1 / 60, { threeCamera: camera });

      // ── Render on top of MapLibre ─────────────────────────────────
      // Save GL state, render clouds, restore
      renderer.state.reset();

      // Enable depth testing so clouds integrate with the globe
      const gl2 = gl as WebGL2RenderingContext;
      gl2.enable(gl2.DEPTH_TEST);
      gl2.depthFunc(gl2.LEQUAL);
      gl2.enable(gl2.BLEND);
      gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA);

      renderer.render(scene, camera);
    },

    onRemove() {
      if (renderer) renderer.dispose();
    },
  };
}
