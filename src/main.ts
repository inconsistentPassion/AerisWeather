/**
 * AerisWeather — Main Entry Point
 * "Windy meets MSFS, but in the browser."
 */

import { createScene } from './scene/Scene';
import { createGlobe } from './scene/Globe';
import { createAtmosphere } from './scene/Atmosphere';
import { createCamera } from './scene/Camera';
import { WeatherManager } from './weather/WeatherManager';
import { CloudRenderer } from './clouds/CloudRenderer';
import { WindParticles } from './wind/WindParticles';
import { createUI } from './ui/UI';

async function init() {
  const container = document.getElementById('app')!;
  const uiContainer = document.getElementById('ui-overlay')!;

  // Core scene
  const { renderer, scene } = createScene(container);

  // Globe
  const globe = createGlobe();
  scene.add(globe);

  // Atmosphere shell
  const atmosphere = createAtmosphere();
  scene.add(atmosphere);

  // Camera (orbit + free-flight)
  const camera = createCamera(container);

  // Weather data manager
  const weather = new WeatherManager();

  // Volumetric clouds
  const clouds = new CloudRenderer(scene, weather);

  // Wind particles
  const wind = new WindParticles(scene, weather);

  // UI controls
  const ui = createUI(uiContainer, weather, {
    onTimeChange: (t) => weather.setTime(t),
    onLevelChange: (l) => weather.setLevel(l),
    onLayerToggle: (layer, active) => weather.toggleLayer(layer, active),
    onCameraMode: (mode) => camera.setMode(mode),
  });

  // Render loop
  let lastTime = performance.now();

  function animate(now: number) {
    requestAnimationFrame(animate);

    const dt = (now - lastTime) / 1000;
    lastTime = now;

    camera.update(dt);
    weather.update(dt);
    clouds.update(dt, camera);
    wind.update(dt, camera);

    renderer.render(scene, camera.threeCamera);
  }

  // Kick off
  await weather.loadInitial();
  animate(performance.now());

  // Resize handling
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.threeCamera.aspect = w / h;
    camera.threeCamera.updateProjectionMatrix();
  });
}

init().catch(console.error);
