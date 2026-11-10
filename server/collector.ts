import * as spotify from './spotify.ts';

/** One collection pass: pull recent plays and complete their album info. Returns how many plays were new. */
export async function collect(): Promise<number> {
  if (!spotify.isAuthed()) return 0;
  try {
    const added = await spotify.syncRecent();
    if (added) console.log(`[sync] +${added} plays`);
    const filled = await spotify.backfillTrackMeta();
    if (filled) console.log(`[sync] filled album info for ${filled} tracks`);
    return added;
  } catch (err) {
    console.error('[sync]', err instanceof Error ? err.message : err);
    return 0;
  }
}
