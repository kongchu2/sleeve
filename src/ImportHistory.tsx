import { useEffect, useRef, useState } from 'react';
import { getImportStatus, postImport, type ImportEntry, type ImportStatus } from './api.ts';
import { BackLink } from './shared.tsx';

const CHUNK = 4000;

type RawStream = {
  ts?: string;
  ms_played?: number;
  spotify_track_uri?: string | null;
  master_metadata_track_name?: string | null;
  master_metadata_album_artist_name?: string | null;
  master_metadata_album_album_name?: string | null;
  endTime?: string;
};

/** Pull music streams out of one "Streaming_History_Audio_*.json" file. Podcasts and videos have no track URI. */
function parseExport(text: string): { entries: ImportEntry[]; basic: boolean } {
  const rows = JSON.parse(text) as RawStream[];
  if (!Array.isArray(rows)) throw new Error('not a streaming history file');
  const basic = rows.length > 0 && rows[0].endTime !== undefined && rows[0].ts === undefined;
  const entries: ImportEntry[] = [];
  for (const r of rows) {
    const id = r.spotify_track_uri?.match(/^spotify:track:([A-Za-z0-9]{22})$/)?.[1];
    const ts = r.ts ? Date.parse(r.ts) : NaN;
    if (!id || !Number.isFinite(ts)) continue;
    entries.push({
      ts,
      id,
      ms: r.ms_played ?? 0,
      name: r.master_metadata_track_name ?? '',
      artist: r.master_metadata_album_artist_name ?? '',
      album: r.master_metadata_album_album_name ?? '',
    });
  }
  return { entries, basic };
}

export function ImportHistory() {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Poll while a job runs (it keeps going on the server even if this page is closed).
  const running = uploading || status?.state === 'running';
  useEffect(() => {
    let live = true;
    const load = () => getImportStatus().then((s) => { if (live) setStatus(s); }, () => {});
    void load();
    if (!running) return () => { live = false; };
    const id = setInterval(load, 1500);
    return () => { live = false; clearInterval(id); };
  }, [running]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setMessage(null);
    try {
      const all: ImportEntry[] = [];
      let sawBasic = false;
      for (const file of files) {
        const { entries, basic } = parseExport(await file.text());
        all.push(...entries);
        sawBasic ||= basic;
      }
      if (!all.length) {
        setMessage(
          sawBasic
            ? 'This looks like the basic "Account data" export, which has no track ids. Request the Extended streaming history instead.'
            : 'No music streams found in those files.',
        );
        return;
      }
      for (let i = 0; i < all.length; i += CHUNK) await postImport(all.slice(i, i + CHUNK));
      setStatus(await getImportStatus());
    } catch (err) {
      setMessage(err instanceof Error ? `Could not read that file: ${err.message}` : 'Could not read that file.');
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const lookup = status && status.tracksTotal ? status.tracksDone / status.tracksTotal : 0;

  return (
    <div className="page">
      <div className="wrap import">
        <header className="cal-title">
          <BackLink />
          <h1 className="page-title">Import history</h1>
        </header>

        <ol className="import-steps">
          <li>
            On <a href="https://www.spotify.com/account/privacy/" target="_blank" rel="noreferrer">spotify.com/account/privacy</a>, request your{' '}
            <strong>Extended streaming history</strong>. Spotify emails a download link, usually within a few days (it can take up to 30).
          </li>
          <li>Unzip it and choose the <code>Streaming_History_Audio_*.json</code> files below.</li>
          <li>Each track is looked up on Spotify for its artwork, so years of history can take a while. You can leave this page; it keeps going.</li>
        </ol>

        <div className="import-actions">
          <input ref={input} id="import-files" className="import-input" type="file" accept=".json,application/json" multiple disabled={running} onChange={(e) => void onFiles(e.target.files)} />
          <label className={'import-button' + (running ? ' is-disabled' : '')} htmlFor="import-files">
            {uploading ? 'Reading files…' : status?.state === 'running' ? 'Import in progress…' : 'Choose files'}
          </label>
        </div>

        {message && <p className="import-message" role="alert">{message}</p>}

        {status && status.state !== 'idle' && (
          <section className="import-status" aria-live="polite">
            {status.state === 'running' && (
              <>
                <div className="bar" role="progressbar" aria-label="Track lookup" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lookup * 100)}>
                  <div className="bar-fill import-fill" style={{ width: lookup * 100 + '%' }} />
                </div>
                <p>
                  Looking up tracks: {status.tracksDone.toLocaleString('en')} of {status.tracksTotal.toLocaleString('en')} ·{' '}
                  {status.received.toLocaleString('en')} plays queued
                </p>
              </>
            )}
            {status.state === 'done' && (
              <p>
                Done. Added <strong>{status.added.toLocaleString('en')}</strong> plays
                {status.skipped > 0 && `, skipped ${status.skipped.toLocaleString('en')} already in your log`}. <a href="#/year">See your year</a>
              </p>
            )}
            {status.state === 'error' && <p role="alert">The import stopped: {status.error}. Choosing the files again resumes it; nothing is added twice.</p>}
          </section>
        )}
      </div>
    </div>
  );
}
