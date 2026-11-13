import { useEffect, useRef, useState } from 'react';
import { getImportStatus, postImport, type ImportEntry, type ImportResult } from './api.ts';
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
  const [coverless, setCoverless] = useState(0);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const uploading = progress !== null;

  // Artwork is filled in by the server after the import; keep the count fresh while any is outstanding.
  useEffect(() => {
    let live = true;
    const load = () => getImportStatus().then((s) => { if (live) setCoverless(s.coverlessTracks); }, () => {});
    void load();
    if (uploading || !coverless) return () => { live = false; };
    const id = setInterval(load, 15_000);
    return () => { live = false; clearInterval(id); };
  }, [uploading, coverless > 0]);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setProgress({ sent: 0, total: 0 });
    setMessage(null);
    setResult(null);
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
      const total: ImportResult = { added: 0, skipped: 0 };
      for (let i = 0; i < all.length; i += CHUNK) {
        const r = await postImport(all.slice(i, i + CHUNK));
        total.added += r.added;
        total.skipped += r.skipped;
        setProgress({ sent: Math.min(i + CHUNK, all.length), total: all.length });
      }
      setResult(total);
    } catch (err) {
      setMessage(
        err instanceof Error
          ? `The import stopped: ${err.message}. Choosing the files again resumes it; nothing is added twice.`
          : 'The import stopped. Choosing the files again resumes it; nothing is added twice.',
      );
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  };

  const sent = progress?.total ? progress.sent / progress.total : 0;

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
          <li>Your plays appear right away. Artwork follows over the next hours; you can leave this page.</li>
        </ol>

        <div className="import-actions">
          <input ref={input} id="import-files" className="import-input" type="file" accept=".json,application/json" multiple disabled={uploading} onChange={(e) => void onFiles(e.target.files)} />
          <label className={'import-button' + (uploading ? ' is-disabled' : '')} htmlFor="import-files">
            {uploading ? 'Importing…' : 'Choose files'}
          </label>
        </div>

        {message && <p className="import-message" role="alert">{message}</p>}

        {(progress?.total || result || coverless > 0) && (
          <section className="import-status" aria-live="polite">
            {progress && progress.total > 0 && (
              <>
                <div className="bar" role="progressbar" aria-label="Import" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(sent * 100)}>
                  <div className="bar-fill import-fill" style={{ width: sent * 100 + '%' }} />
                </div>
                <p>
                  Importing: {progress.sent.toLocaleString('en')} of {progress.total.toLocaleString('en')} streams
                </p>
              </>
            )}
            {result && (
              <p>
                Done. Added <strong>{result.added.toLocaleString('en')}</strong> plays
                {result.skipped > 0 && `, skipped ${result.skipped.toLocaleString('en')} already in your log`}. <a href="#/year">See your year</a>
              </p>
            )}
            {!uploading && coverless > 0 && <p>Artwork for {coverless.toLocaleString('en')} tracks is still being looked up.</p>}
          </section>
        )}
      </div>
    </div>
  );
}
