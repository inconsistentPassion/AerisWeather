/**
 * UI — Time slider, level selector, layer toggles, camera mode.
 * Responsive design with mobile support.
 */

import type { WeatherManager } from '../weather/WeatherManager';
import type { WeatherLevel, WeatherLayer } from '../weather/types';
import type { CameraMode } from '../scene/Camera';

interface UIActions {
  onTimeChange: (timestamp: number) => void;
  onLevelChange: (level: WeatherLevel) => void;
  onLayerToggle: (layer: WeatherLayer, active: boolean) => void;
  onCameraMode: (mode: CameraMode) => void;
}

export function createUI(container: HTMLElement, weather: WeatherManager, actions: UIActions) {
  container.innerHTML = `
    <div class="aeris-ui">
      <!-- Header -->
      <div class="ui-header">
        <div class="logo">⛅ AerisWeather</div>
        <div class="fps-counter" id="fps-counter">-- FPS</div>
      </div>

      <!-- Main controls panel -->
      <div class="ui-panel main-panel">
        <!-- Time control -->
        <div class="control-group">
          <label>⏱ Time</label>
          <div class="time-row">
            <button id="btn-play" class="icon-btn" title="Play/Pause (Space)">▶</button>
            <input type="range" id="time-slider" min="0" max="120" value="0" step="1" />
            <span id="time-display" class="time-label">Now</span>
          </div>
        </div>

        <!-- Level selector -->
        <div class="control-group">
          <label>📊 Level</label>
          <div class="level-buttons">
            <button class="level-btn active" data-level="surface">SFC</button>
            <button class="level-btn" data-level="925hPa">925</button>
            <button class="level-btn" data-level="850hPa">850</button>
            <button class="level-btn" data-level="700hPa">700</button>
            <button class="level-btn" data-level="500hPa">500</button>
            <button class="level-btn" data-level="300hPa">300</button>
            <button class="level-btn" data-level="FL300">FL350</button>
          </div>
        </div>

        <!-- Layer toggles -->
        <div class="control-group">
          <label>🗺 Layers</label>
          <div class="layer-toggles">
            <button class="layer-btn active" data-layer="wind">💨 Wind</button>
            <button class="layer-btn active" data-layer="clouds">☁️ Clouds</button>
            <button class="layer-btn" data-layer="temperature">🌡️ Temp</button>
            <button class="layer-btn" data-layer="pressure">📊 Pressure</button>
            <button class="layer-btn" data-layer="humidity">💧 Humidity</button>
          </div>
        </div>

        <!-- Camera mode -->
        <div class="control-group">
          <label>📷 Camera</label>
          <div class="camera-buttons">
            <button class="cam-btn active" data-mode="orbit">🌍 Orbit</button>
            <button class="cam-btn" data-mode="freeflight">✈️ Free Flight</button>
          </div>
        </div>
      </div>

      <!-- Info bar -->
      <div class="ui-info-bar">
        <span id="cursor-info">Hover globe for details</span>
        <span id="data-source">Procedural Data</span>
      </div>
    </div>
  `;

  // Inject responsive styles
  const style = document.createElement('style');
  style.textContent = `
    .aeris-ui {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 10;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e0e8f0;
      pointer-events: none;
    }
    .aeris-ui > * { pointer-events: auto; }

    /* Header */
    .ui-header {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 20px;
      background: linear-gradient(180deg, rgba(0, 5, 16, 0.85) 0%, transparent 100%);
      pointer-events: none;
    }
    .ui-header > * { pointer-events: auto; }
    .logo {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.3px;
      text-shadow: 0 0 20px rgba(100, 180, 255, 0.3);
    }
    .fps-counter {
      font-size: 11px;
      color: #556677;
      font-variant-numeric: tabular-nums;
      background: rgba(0, 5, 16, 0.5);
      padding: 4px 8px;
      border-radius: 4px;
    }

    /* Main panel */
    .main-panel {
      margin: 0 16px 16px;
      background: rgba(10, 20, 40, 0.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(100, 140, 200, 0.15);
      border-radius: 12px;
      padding: 14px 18px;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
      align-items: flex-start;
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .control-group label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: rgba(160, 190, 230, 0.5);
    }

    /* Time control */
    .time-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icon-btn {
      background: rgba(70, 130, 220, 0.3);
      border: 1px solid rgba(100, 160, 255, 0.3);
      color: #8ab4e8;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .icon-btn:hover {
      background: rgba(70, 130, 220, 0.5);
      color: #fff;
    }
    #time-slider {
      width: 180px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: rgba(255, 255, 255, 0.15);
      border-radius: 2px;
      outline: none;
    }
    #time-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #6ab0ff;
      cursor: pointer;
      box-shadow: 0 0 8px rgba(60, 140, 255, 0.4);
    }
    .time-label {
      font-size: 13px;
      color: #8899aa;
      min-width: 45px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }

    /* Buttons */
    .level-buttons, .layer-toggles, .camera-buttons {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .level-btn, .layer-btn, .cam-btn {
      background: rgba(40, 60, 100, 0.4);
      border: 1px solid rgba(80, 120, 180, 0.2);
      border-radius: 6px;
      color: #8899aa;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.15s;
    }
    .level-btn:hover, .layer-btn:hover, .cam-btn:hover {
      background: rgba(60, 90, 150, 0.5);
      color: #c0d0e0;
    }
    .level-btn.active, .cam-btn.active {
      background: rgba(70, 130, 220, 0.4);
      border-color: rgba(100, 160, 255, 0.4);
      color: #fff;
    }
    .layer-btn.active {
      background: rgba(60, 160, 100, 0.35);
      border-color: rgba(80, 200, 120, 0.3);
      color: #b0e8c8;
    }

    /* Info bar */
    .ui-info-bar {
      display: flex;
      justify-content: space-between;
      padding: 8px 20px;
      font-size: 11px;
      color: #445566;
    }

    /* ── Responsive: Tablet ── */
    @media (max-width: 768px) {
      .main-panel {
        margin: 0 8px 8px;
        padding: 10px 12px;
        gap: 12px;
      }
      #time-slider { width: 120px; }
      .level-btn, .layer-btn, .cam-btn {
        padding: 5px 8px;
        font-size: 11px;
      }
    }

    /* ── Responsive: Mobile ── */
    @media (max-width: 480px) {
      .ui-header { padding: 8px 12px; }
      .logo { font-size: 15px; }
      .main-panel {
        flex-direction: column;
        gap: 10px;
        margin: 0 4px 4px;
        padding: 10px;
        border-radius: 8px;
      }
      .control-group { width: 100%; }
      .time-row { width: 100%; }
      #time-slider { flex: 1; width: auto; }
      .level-buttons, .layer-toggles {
        width: 100%;
        justify-content: center;
      }
      .ui-info-bar { padding: 4px 12px; font-size: 10px; }
    }

    /* Touch-friendly targets */
    @media (pointer: coarse) {
      .level-btn, .layer-btn, .cam-btn {
        min-height: 44px;
        min-width: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .icon-btn {
        width: 44px;
        height: 44px;
        font-size: 18px;
      }
    }
  `;
  document.head.appendChild(style);

  // ── Event wiring ────────────────────────────────────────────────────

  let playing = false;
  let playInterval: ReturnType<typeof setInterval> | null = null;

  // Play button
  const playBtn = container.querySelector('#btn-play') as HTMLButtonElement;
  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸' : '▶';

    if (playing) {
      playInterval = setInterval(() => {
        const val = parseInt(timeSlider.value);
        timeSlider.value = String(val >= 120 ? 0 : val + 1);
        updateTimeDisplay();
      }, 300);
    } else if (playInterval) {
      clearInterval(playInterval);
      playInterval = null;
    }
  });

  // Time slider
  const timeSlider = container.querySelector('#time-slider') as HTMLInputElement;
  const timeDisplay = container.querySelector('#time-display')!;

  function updateTimeDisplay() {
    const hours = parseInt(timeSlider.value);
    timeDisplay.textContent = hours === 0 ? 'Now' : `+${hours}h`;
    const now = new Date();
    now.setHours(now.getHours() + hours);
    actions.onTimeChange(now.getTime());
  }

  timeSlider.addEventListener('input', updateTimeDisplay);

  // Level buttons
  container.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.onLevelChange(btn.getAttribute('data-level') as WeatherLevel);
    });
  });

  // Layer toggles
  container.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.getAttribute('data-layer') as WeatherLayer;
      const isActive = btn.classList.toggle('active');
      actions.onLayerToggle(layer, isActive);
    });
  });

  // Camera mode
  container.querySelectorAll('.cam-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.onCameraMode(btn.getAttribute('data-mode') as CameraMode);
    });
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      playBtn.click();
    }
  });

  // FPS counter
  const fpsEl = container.querySelector('#fps-counter')!;
  let frameCount = 0;
  let lastFpsTime = performance.now();

  function updateFPS() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 500) {
      fpsEl.textContent = `${Math.round(frameCount / ((now - lastFpsTime) / 1000))} FPS`;
      frameCount = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(updateFPS);
  }
  requestAnimationFrame(updateFPS);

  return { container };
}
