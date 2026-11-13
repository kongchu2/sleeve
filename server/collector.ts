import * as spotify from './spotify.ts';

/** One collection pass: pull recent plays. Returns how many were new. */
export async function collect(): Promise<number> {
  if (!spotify.isAuthed()) return 0;
  try {
    const added = await spotify.syncRecent();
    if (added) console.log(`[sync] +${added} plays`);
    return added;
  } catch (err) {
    console.error('[sync]', err instanceof Error ? err.message : err);
    return 0;
  }
}
