import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './db.js';
import { authRouter, secret } from './auth.js';
import { apiRouter } from './api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(db = openDb()) {
  secret(); // fail fast if production has no session secret
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'",
    });
    next();
  });
  // Cross-site requests cannot carry our JSON content type without a preflight, which we never allow.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, demo: process.env.SLATE_DEMO === '1' }));
  app.use('/api/auth', authRouter(db));
  app.use('/api', apiRouter(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(join(root, 'public'), { extensions: ['html'] }));
  app.get('*', (req, res) => res.sendFile(join(root, 'public', 'index.html')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !err.status ? 'Something went wrong on the server' : err.message });
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Slate running on http://localhost:${port}`));
}
