/**
 * AerisWeather Backend — Weather proxy, normalization, and tile server.
 */

import express from 'express';
import cors from 'cors';
import { weatherRouter } from './routes/weather';
import { tileRouter } from './routes/tiles';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/weather', weatherRouter);
app.use('/api/tiles', tileRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.listen(PORT, () => {
  console.log(`🌤️  AerisWeather server running on http://localhost:${PORT}`);
});
