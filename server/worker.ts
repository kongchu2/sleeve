/**
 * Collector worker: keeps pulling recent plays from Spotify into the database and
 * publishes them to the listening archive repository. Runs without the web server.
 */
import { archiveEnabled, archivePending, importArchive, pushArchive } from './archive.ts';
import { coverImported, settleImported } from './importer.ts';
import { startPoller } from './poller.ts';
import * as spotify from './spotify.ts';

const PUSH_INTERVAL = Number(process.env.ARCHIVE_PUSH_MINUTES ?? 15) * 60 * 1000;

let lastPush = 0;
let synced = false; // the first publish after starting rewrites every month, so the archive matches the database
let running: Promise<void> | null = null;

// Plays arrive from the poller, from history imports through the web server and from the cover lookups;
// the database notes which months they touched (see `archive_dirty` in server/db.ts).
function publish(force = false): Promise<void> {
  if (running) return running;
  if (!archiveEnabled() || (synced && !archivePending())) return Promise.resolve();
  if (!force && Date.now() - lastPush < PUSH_INTERVAL) return Promise.resolve();
  running = pushArchive(!synced)
    .then(
      (pushed) => {
        if (pushed) console.log('[archive] pushed');
        synced = true;
        lastPush = Date.now();
      },
      (err) => console.error('[archive]', err instanceof Error ? err.message : err),
    )
    .finally(() => { running = null; });
  return running;
}

if (!spotify.isConfigured()) console.log('Spotify credentials missing: copy .env.example to .env and fill it in.');
if (!spotify.isAuthed()) console.log('Not connected to Spotify yet: sign in through the web app first.');
if (archiveEnabled()) {
  const restored = importArchive();
  if (restored) console.log(`[archive] restored ${restored} plays from the archive`);
} else {
  console.log('[archive] DATA_REPO_DIR is not a git repository: archiving is off.');
}

console.log('sleeve worker started');
startPoller();
void publish();
setInterval(() => void publish(), 60_000);
// Imported history arrives without artwork; find it in the background.
settleImported();
void coverImported();

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    // Let a push already under way finish, then publish whatever is left.
    void (async () => {
      await running;
      await publish(true);
      process.exit(0);
    })();
  });
}
