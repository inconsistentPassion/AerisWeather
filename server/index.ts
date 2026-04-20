/**
 * AerisWeather Backend — Weather proxy, normalization, and tile server.
 * Enhanced with error handling, rate limiting, and detailed health check.
 */

import express from 'express';
import cors from 'cors';
import { weatherRouter } from './routes/weather';
import { tileRouter } from './routes/tiles';
import { cloudRouter } from './routes/clouds';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

// CORS configuration
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (duration > 100 || res.statusCode >= 400) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Rate limiting (simple in-memory)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW = 60000; // 1 minute

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = requestCounts.get(ip);
  
  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return next();
  }
  
  if (record.count >= RATE_LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: Math.ceil((record.resetTime - now) / 1000) });
  }
  
  record.count++;
  next();
});

// Routes
app.use('/api/weather', weatherRouter);
app.use('/api/weather', cloudRouter);
app.use('/api/tiles', tileRouter);

// Enhanced health check
const startTime = Date.now();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: Date.now(),
    memory: process.memoryUsage(),
    features: {
      weather: true,
      tiles: true,
      gfs: true,
      cache: true,
    },
  });
});

// API documentation
app.get('/api', (_req, res) => {
  res.json({
    name: 'AerisWeather API',
    version: '0.1.0',
    endpoints: {
      weather: {
        'GET /api/weather/grid?level=...&time=...': 'Get weather grid data',
        'GET /api/weather/forecast?level=...&hours=...': 'Get forecast timeline',
        'GET /api/weather/cycle': 'Get current GFS cycle info',
        'GET /api/weather/clouds?lat={lat}&lon={lon}&time={iso}&debug={bool}': 'Get cloud data at point (GFS primary, NASA POWER fallback)',
        'GET /api/weather/cache/stats': 'Get cache statistics',
        'POST /api/weather/cache/clear': 'Clear weather cache',
      },
      tiles: {
        'GET /api/tiles/:field/:z/:x/:y.png?level=...&time=...': 'Get weather tile (field: clouds, temperature, humidity, wind, pressure)',
        'GET /api/tiles/cloud-texture/:z/:x/:y.png?debug=...': 'Get cloud intensity texture for volumetric rendering (GFS→OpenMeteo→POWER→procedural)',
        'GET /api/tiles/:field/meta': 'Get tile metadata',
      },
    },
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Server] Error:', err.message);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`🌤️  AerisWeather server running on http://localhost:${PORT}`);
  console.log(`📊 API docs: http://localhost:${PORT}/api`);
  console.log(`❤️  Health: http://localhost:${PORT}/health`);
});

// Setup WebSocket for real-time updates
import { setupWebSocket } from './ws';
const wss = setupWebSocket(server);
console.log(`🔌 WebSocket ready at ws://localhost:${PORT}/ws`);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  wss.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Server] Interrupted, shutting down...');
  wss.close();
  process.exit(0);
});
