/**
 * WebSocket server for real-time weather updates.
 * Provides live data streaming to connected clients.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { generateWeatherGrid } from './normalize/grid';

export function setupWebSocket(server: any): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const clients = new Set<WebSocket>();
  let updateInterval: ReturnType<typeof setInterval> | null = null;

  wss.on('connection', (ws: WebSocket) => {
    console.log('[WS] Client connected');
    clients.add(ws);

    // Send initial data
    const initialData = {
      type: 'init',
      timestamp: Date.now(),
      levels: ['surface', '850hPa', '500hPa', 'FL100', 'FL200', 'FL300'],
    };
    ws.send(JSON.stringify(initialData));

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      clients.delete(ws);

      // Stop updates if no clients
      if (clients.size === 0 && updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg);
      } catch (err) {
        console.error('[WS] Invalid message:', err);
      }
    });

    // Start updates if first client
    if (!updateInterval) {
      startUpdates();
    }
  });

  function handleMessage(ws: WebSocket, msg: any) {
    switch (msg.type) {
      case 'subscribe':
        // Client wants updates for a specific level
        console.log(`[WS] Client subscribed to ${msg.level}`);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;
    }
  }

  function startUpdates() {
    // Send weather updates every 30 seconds
    updateInterval = setInterval(() => {
      if (clients.size === 0) return;

      const now = new Date().toISOString();
      const grid = generateWeatherGrid('surface', now, 180, 90); // Lower res for streaming

      const update = {
        type: 'weather_update',
        timestamp: Date.now(),
        level: 'surface',
        data: {
          width: grid.width,
          height: grid.height,
          // Send compressed fields
          cloudCoverage: compressFlatField(grid.fields.cloudFraction ?? new Float32Array(180 * 90), 180, 90),
        },
      };

      const message = JSON.stringify(update);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }, 30000);
  }

  function compressFlatField(field: Float32Array, width: number, height: number): number[] {
    const result: number[] = [];
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        result.push(field[y * width + x] ?? 0);
      }
    }
    return result;
  }

  console.log('[WS] WebSocket server ready at /ws');
  return wss;
}
