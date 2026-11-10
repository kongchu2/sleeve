import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { control, getLyrics, type Lyrics, type Now } from './api.ts';
import { usePalette } from './color.ts';

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/** Playback position, advanced locally between server polls. */
function usePosition(now: Now | null): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!now?.isPlaying) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [now?.isPlaying]);
  if (!now) return 0;
  const pos = now.isPlaying ? now.progressMs + (Date.now() - now.receivedAt) : now.progressMs;
  return Math.min(pos, now.track.durationMs);
}

/** Fullscreen state for an element, plus an "idle" flag that hides chrome when the pointer rests. */
function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);

  useEffect(() => {
    if (!active) { setIdle(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), 2500);
    };
    wake();
    addEventListener('pointermove', wake);
    addEventListener('pointerdown', wake);
    addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      removeEventListener('pointermove', wake);
      removeEventListener('pointerdown', wake);
      removeEventListener('keydown', wake);
    };
  }, [active]);

  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen().catch(() => {});
  };

  return { active, idle, toggle };
}

export function NowPlaying({ now, refresh }: { now: Now | null; refresh: () => Promise<void> }) {
  const track = now?.track ?? null;
  const palette = usePalette(track?.imageS);
  const pos = usePosition(now);
  const [lyrics, setLyrics] = useState<Lyrics | 'loading' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(rootRef);

  // "F" toggles fullscreen; Esc is handled by the browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'f' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      fs.toggle();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackId = track?.id;
  useEffect(() => {
    if (!track) { setLyrics(null); return; }
    let live = true;
    setLyrics('loading');
    getLyrics(track).then(
      (l) => { if (live) setLyrics(l); },
      () => { if (live) setLyrics(null); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  const act = async (action: Parameters<typeof control>[0], ms?: number) => {
    const res = await control(action, ms);
    if (res.status === 403) setNotice('Playback control needs a Spotify Premium account.');
    else if (res.status === 404) setNotice('No active Spotify device found.');
    else setNotice(null);
    setTimeout(() => void refresh(), 350);
  };

  const style = { '--ground': palette.ground, '--soft': palette.soft, '--point': palette.point } as CSSProperties;

  return (
    <div ref={rootRef} className={'np' + (fs.active ? ' is-fs' : '') + (fs.idle ? ' is-idle' : '')} style={style}>
      {track?.imageM && <img className="blob-a" src={track.imageM} alt="" key={track.imageM} />}
      <div className="blob-b" aria-hidden="true" />
      <div className="np-veil" aria-hidden="true" />

      <div className="np-wrap">
        <header className="np-header">
          <a className="back" href="#/" aria-label="Back to calendar">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          </a>
          <button className="fs-btn" aria-label={fs.active ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fs.active} onClick={fs.toggle}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {fs.active ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
            </svg>
          </button>
        </header>

        {!now || !track ? (
          <main className="np-idle">
            <h1>Nothing is playing right now</h1>
            <p>Start something on Spotify and this screen takes on the colour of its album.</p>
          </main>
        ) : (
          <main className="np-main">
              <section className="np-left" aria-label="Current track">
                {track.imageL ? (
                  <img className={'cover' + (now.isPlaying ? '' : ' is-paused')} src={track.imageL} alt={`${track.album} album cover`} key={track.imageL} />
                ) : (
                  <div className="cover cover-blank" role="img" aria-label="No album cover" />
                )}
                <div className="np-titles">
                  <h1>{track.name}</h1>
                  <div className="np-artist">{track.artists}</div>
                  <div className="np-album">{track.album}</div>
                </div>
                <div className="np-progress">
                  <div className="bar" role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((pos / track.durationMs) * 100)}>
                    <div className="bar-fill" style={{ width: (pos / track.durationMs) * 100 + '%' }} />
                  </div>
                  <div className="np-times"><span>{fmt(pos)}</span><span>{fmt(track.durationMs)}</span></div>
                </div>
                <div className="np-controls">
                  <button className="ctl" aria-label="Previous track" onClick={() => act('previous')}>
                    <svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d="M19 6v12l-9-6z" /><path d="M6 6v12" fill="none" strokeWidth="2.4" /></svg>
                  </button>
                  <button className="ctl ctl-main" aria-label={now.isPlaying ? 'Pause' : 'Play'} onClick={() => act(now.isPlaying ? 'pause' : 'play')}>
                    {now.isPlaying ? (
                      <svg aria-hidden="true" width="44" height="44" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                    ) : (
                      <svg aria-hidden="true" width="44" height="44" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d="M8 5l11 7-11 7z" /></svg>
                    )}
                  </button>
                  <button className="ctl" aria-label="Next track" onClick={() => act('next')}>
                    <svg aria-hidden="true" width="30" height="30" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d="M5 6v12l9-6z" /><path d="M18 6v12" fill="none" strokeWidth="2.4" /></svg>
                  </button>
                </div>
                {notice && <div className="np-notice" role="status">{notice}</div>}
              </section>

              <section className="np-right" aria-label="Lyrics">
                <LyricsView lyrics={lyrics} pos={pos} onSeek={(ms) => act('seek', ms)} />
              </section>
            </main>
        )}
      </div>
    </div>
  );
}

function LyricsView({ lyrics, pos, onSeek }: { lyrics: Lyrics | 'loading' | null; pos: number; onSeek: (ms: number) => void }) {
  // No lyrics, an instrumental, or still loading: leave the space empty.
  if (!lyrics || lyrics === 'loading' || lyrics.instrumental) return null;
  if (lyrics.synced) return <SyncedLyrics lines={lyrics.synced} pos={pos} onSeek={onSeek} />;
  if (lyrics.plain) return <div className="lyrics-plain">{lyrics.plain}</div>;
  return null;
}

function SyncedLyrics({ lines, pos, onSeek }: { lines: { t: number; text: string }[]; pos: number; onSeek: (ms: number) => void }) {
  const active = lines.findLastIndex((l) => l.t <= pos);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const innerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  // Lines wrap, so the scroll offset is measured rather than computed from a fixed row height.
  useLayoutEffect(() => {
    const measure = () => setOffset(refs.current[Math.max(0, active)]?.offsetTop ?? 0);
    measure();
    // Re-measure whenever the lyric block reflows (window resize, fullscreen, font load).
    const observer = new ResizeObserver(measure);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [active, lines]);

  return (
    <div className="lyrics">
      <div className="lyrics-inner" ref={innerRef} style={{ transform: `translateY(${-offset}px)` }}>
        {lines.map((l, i) => (
          <button
            key={i}
            ref={(el) => { refs.current[i] = el; }}
            className={'line' + (i === active ? ' is-active' : i < active ? ' is-past' : '')}
            aria-current={i === active ? 'true' : undefined}
            style={{ filter: i === active ? undefined : `blur(${Math.min(Math.abs(i - Math.max(0, active)) * 0.7, 3.5)}px)` }}
            onClick={() => onSeek(l.t)}
          >
            {l.text}
          </button>
        ))}
      </div>
    </div>
  );
}
