import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = process.env.SOFTEX_DATA_DIR ?? join(root, 'data');

const { server } = createApp({
  dbPath: process.env.SOFTEX_DB ?? join(dataDir, 'softex.db'),
  uploadDir: join(dataDir, 'uploads'),
  meetingBaseUrl: process.env.SOFTEX_MEETING_BASE_URL,
  maxUploadBytes: process.env.SOFTEX_MAX_UPLOAD_MB ? Number(process.env.SOFTEX_MAX_UPLOAD_MB) * 1024 * 1024 : undefined,
  secureCookies: process.env.SOFTEX_SECURE_COOKIES === 'true',
  staticDir: process.env.SOFTEX_STATIC_DIR ?? resolve(root, '..', 'client', 'dist'),
});

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => {
  console.log(`SoftEX server listening on http://localhost:${port}`);
});
