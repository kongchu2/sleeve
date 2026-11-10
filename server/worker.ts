/**
 * Collector worker: keeps pulling recent plays from Spotify into the database and
 * publishes them to the listening archive repository. Runs without the web server.
 */
import { archiveEnabled, importArchive, pushArchive } from './archive.ts';
import { collect } from './collector.ts';
import * as spotify from './spotify.ts';

const SYNC_INTERVAL = 2 * 60 * 1000;
const PUSH_INTERVAL = Number(process.env.ARCHIVE_PUSH_MINUTES ?? 15) * 60 * 1000;

let dirty = true; // publish once on startup so the archive matches the database
let lastPush = 0;

function publish(force = false) {
  if (!archiveEnabled() || !dirty) return;
  if (!force && Date.now() - lastPush < PUSH_INTERVAL) return;
  try {
    if (pushArchive()) console.log('[archive] pushed');
    dirty = false;
    lastPush = Date.now();
  } catch (err) {
    console.error('[archive]', err instanceof Error ? err.message : err);
  }
}

async function tick() {
  if ((await collect()) > 0) dirty = true;
  publish();
}

if (!spotify.isConfigured()) console.log('Spotify credentials missing: copy .env.example to .env and fill it in.');
if (!spotify.isAuthed()) console.log('Not connected to Spotify yet: sign in through the web app first.');
if (archiveEnabled()) {
  const restored = importArchive();
  if (restored) console.log(`[archive] restored ${restored} plays from the archive`);
} else {
  console.log('[archive] DATA_REPO_DIR is not a git repository: archiving is off.');
}

console.log('listening-calendar worker started');
void tick();
setInterval(tick, SYNC_INTERVAL);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    publish(true);
    process.exit(0);
  });
}
