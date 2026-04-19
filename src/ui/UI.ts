/**
 * UI — XWeather/AerisWeather-inspired controls panel.
 * 
 * Reverse-engineered from XWeather's dashboard:
 * - Clean dark theme with blue accent colors
 * - Compact horizontal layout
 * - Glassmorphism panel (frosted glass)
 * - Smooth button transitions
 * - FPS counter + data source indicator
 * - Responsive design for mobile/tablet
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
        <div class="logo">
          <span class="logo-icon">🌐</span>
          <span class="logo-text">AerisWeather</span>
        </div>
        <div class="header-right">
          <div class="loading-indicator" id="loading-indicator" style="display: none;">
            <div class="spinner"></div>
            <span>Loading...</span>
          </div>
          <div class="fps-counter" id="fps-counter">-- FPS</div>
        </div>
      </div>

      <!-- Main controls panel (XWeather-style bottom bar) -->
      <div class="ui-panel main-panel">
        <!-- Time control -->
        <div class="control-group">
          <label>⏱ FORECAST</label>
          <div class="time-row">
            <button id="btn-play" class="icon-btn" title="Play/Pause (Space)">▶</button>
            <input type="range" id="time-slider" min="-6" max="120" value="0" step="1" />
            <span id="time-display" class="time-label">Now</span>
          </div>
        </div>

        <!-- Level selector -->
        <div class="control-group">
          <label>📊 ALTITUDE</label>
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
          <label>🗺 LAYERS</label>
          <div class="layer-toggles">
            <button class="layer-btn active" data-layer="wind">💨 Wind</button>
            <button class="layer-btn active" data-layer="radar">🛰️ Radar</button>
            <button class="layer-btn" data-layer="temperature">🌡️ Temp</button>
            <button class="layer-btn" data-layer="pressure">📊 Pressure</button>
            <button class="layer-btn" data-layer="humidity">💧 Humidity</button>
          </div>
        </div>

        <!-- Camera mode -->
        <div class="control-group">
          <label>📷 VIEW</label>
          <div class="camera-buttons">
            <button class="cam-btn active" data-mode="orbit">🌍 Globe</button>
            <button class="cam-btn" data-mode="freeflight">✈️ Free</button>
          </div>
        </div>
      </div>

      <!-- Info bar -->
      <div class="ui-info-bar">
        <span id="cursor-info">Hover globe for details</span>
        <span id="data-source">Open-Meteo + RainViewer</span>
      </div>
    </div>
  `;

  // Inject XWeather-inspired styles
  const style = document.createElement('style');
  style.textContent = `
    .aeris-ui {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 10;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, -sans-serif;
      color: #c8d6e5;
      pointer-events: none;
    }
    .aeris-ui > * { pointer-events: auto; }

    /* ── Header ── */
    .ui-header {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 24px;
      background: linear-gradient(180deg, rgba(5, 10, 25, 0.9) 0%, rgba(5, 10, 25, 0.4) 60%, transparent 100%);
      pointer-events: none;
    }
    .ui-header > * { pointer-events: auto; }

    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .logo-icon {
      font-size: 22px;
      filter: drop-shadow(0 0 8px rgba(100, 180, 255, 0.4));
    }
    .logo-text {
      font-size: 17px;
      font-weight: 600;
      letter-spacing: -0.4px;
      background: linear-gradient(135deg, #6ab0ff, #45a3ff, #2e8bff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      text-shadow: none;
    }

    .fps-counter {
      font-size: 11px;
      color: #4a5568;
      font-variant-numeric: tabular-nums;
      background: rgba(15, 20, 35, 0.7);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid rgba(80, 120, 180, 0.12);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .loading-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: #6b7b8d;
      background: rgba(15, 20, 35, 0.7);
      backdrop-filter: blur(8px);
      padding: 5px 12px;
      border-radius: 6px;
      border: 1px solid rgba(80, 120, 180, 0.12);
    }

    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(100, 180, 255, 0.2);
      border-top-color: #4a9eff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Main Panel (XWeather-style frosted glass bottom bar) ── */
    .main-panel {
      margin: 0 20px 20px;
      background: rgba(12, 18, 35, 0.88);
      backdrop-filter: blur(20px) saturate(1.2);
      -webkit-backdrop-filter: blur(20px) saturate(1.2);
      border: 1px solid rgba(100, 140, 200, 0.12);
      border-radius: 14px;
      padding: 16px 22px;
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
      align-items: flex-start;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .control-group {
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .control-group label {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: rgba(140, 170, 210, 0.4);
    }

    /* ── Time Control ── */
    .time-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .icon-btn {
      background: rgba(55, 110, 190, 0.25);
      border: 1px solid rgba(80, 140, 240, 0.25);
      color: #7aa8e0;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    .icon-btn:hover {
      background: rgba(55, 110, 190, 0.45);
      color: #fff;
      border-color: rgba(80, 140, 240, 0.4);
      box-shadow: 0 0 12px rgba(60, 140, 255, 0.2);
    }

    #time-slider {
      width: 160px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    #time-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #4a9eff;
      cursor: pointer;
      box-shadow: 0 0 10px rgba(60, 140, 255, 0.5), 0 0 3px rgba(60, 140, 255, 0.3);
      transition: box-shadow 0.2s;
    }
    #time-slider::-webkit-slider-thumb:hover {
      box-shadow: 0 0 16px rgba(60, 140, 255, 0.7), 0 0 4px rgba(60, 140, 255, 0.4);
    }

    .time-label {
      font-size: 13px;
      color: #6b7b8d;
      min-width: 45px;
      text-align: center;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }

    /* ── Buttons ── */
    .level-buttons, .layer-toggles, .camera-buttons {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .level-btn, .layer-btn, .cam-btn {
      background: rgba(30, 45, 75, 0.5);
      border: 1px solid rgba(60, 90, 140, 0.15);
      border-radius: 7px;
      color: #6b7b8d;
      padding: 7px 13px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: all 0.15s ease;
      user-select: none;
    }
    .level-btn:hover, .layer-btn:hover, .cam-btn:hover {
      background: rgba(45, 70, 120, 0.5);
      color: #a0b8d0;
      border-color: rgba(80, 120, 180, 0.25);
    }

    .level-btn.active, .cam-btn.active {
      background: rgba(55, 110, 190, 0.35);
      border-color: rgba(80, 140, 240, 0.35);
      color: #fff;
      box-shadow: 0 0 8px rgba(60, 140, 255, 0.15);
    }

    .layer-btn.active {
      background: rgba(40, 140, 80, 0.3);
      border-color: rgba(60, 180, 100, 0.25);
      color: #8fd4a8;
    }

    /* ── Info Bar ── */
    .ui-info-bar {
      display: flex;
      justify-content: space-between;
      padding: 6px 24px 8px;
      font-size: 10px;
      color: #3a4858;
      font-weight: 500;
    }

    /* ── Responsive: Tablet ── */
    @media (max-width: 768px) {
      .main-panel {
        margin: 0 10px 10px;
        padding: 12px 14px;
        gap: 14px;
      }
      #time-slider { width: 110px; }
      .level-btn, .layer-btn, .cam-btn {
        padding: 6px 9px;
        font-size: 10px;
      }
      .logo-text { font-size: 15px; }
    }

    /* ── Responsive: Mobile ── */
    @media (max-width: 480px) {
      .ui-header { padding: 10px 14px; }
      .logo-text { font-size: 14px; }
      .main-panel {
        flex-direction: column;
        gap: 10px;
        margin: 0 6px 6px;
        padding: 12px;
        border-radius: 10px;
      }
      .control-group { width: 100%; }
      .time-row { width: 100%; }
      #time-slider { flex: 1; width: auto; }
      .level-buttons, .layer-toggles {
        width: 100%;
        justify-content: center;
      }
      .ui-info-bar { padding: 4px 14px; font-size: 9px; }
    }

    /* ── Touch targets ── */
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

  const playBtn = container.querySelector('#btn-play') as HTMLButtonElement;
  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸' : '▶';

    if (playing) {
      playInterval = setInterval(() => {
        const val = parseInt(timeSlider.value);
        timeSlider.value = String(val >= 120 ? -6 : val + 1);
        updateTimeDisplay();
      }, 300);
    } else if (playInterval) {
      clearInterval(playInterval);
      playInterval = null;
    }
  });

  const timeSlider = container.querySelector('#time-slider') as HTMLInputElement;
  const timeDisplay = container.querySelector('#time-display')!;

  function updateTimeDisplay() {
    const hours = parseInt(timeSlider.value);
    if (hours === 0) {
      timeDisplay.textContent = 'Now';
    } else if (hours > 0) {
      timeDisplay.textContent = `+${hours}h`;
    } else {
      timeDisplay.textContent = `${hours}h`;
    }
    const now = new Date();
    now.setHours(now.getHours() + hours);
    actions.onTimeChange(now.getTime());
  }

  timeSlider.addEventListener('input', updateTimeDisplay);

  container.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.onLevelChange(btn.getAttribute('data-level') as WeatherLevel);
    });
  });

  container.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.getAttribute('data-layer') as WeatherLayer;
      const isActive = btn.classList.toggle('active');
      actions.onLayerToggle(layer, isActive);
    });
  });

  container.querySelectorAll('.cam-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.onCameraMode(btn.getAttribute('data-mode') as CameraMode);
    });
  });

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

  // Loading state
  const loadingEl = container.querySelector('#loading-indicator') as HTMLElement;
  weather.on('loadingChange', (data: { loading: boolean }) => {
    loadingEl.style.display = data.loading ? 'flex' : 'none';
  });

  if (weather.getLoading()) {
    loadingEl.style.display = 'flex';
  }

  return { container };
}
