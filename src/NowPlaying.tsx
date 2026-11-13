import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { getLyrics, type Lyrics, type Now } from './api.ts';
import { usePalette } from './color.ts';
import { langOf } from './lang.ts';
import { Standby } from './Standby.tsx';

const FLOAT_KEY = 'cover-float';
/** The cover's size is the automatic fit times this factor, chosen by the user and remembered in this browser. */
const SCALE_KEY = 'cover-scale';
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.5;
const SCALE_STEP = 0.1;
const clampScale = (n: number) => Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) * 10) / 10;
/** How long playback must stay stopped (with the pointer at rest) before the standby screen takes over. */
const STANDBY_DELAY_MS = 10_000;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

/** Playback position at this instant, advanced locally from the last server answer. */
const positionOf = (now: Now) =>
  Math.min(now.isPlaying ? now.progressMs + (Date.now() - now.receivedAt) : now.progressMs, now.track.durationMs);

// This screen is left on all day, so what moves with the clock is kept small: only the progress bar
// re-renders on a timer, and the lyrics only when the line changes.

/**
 * The progress bar and its times, re-rendered five times a second while playing. The bar is scaled, not
 * resized, so moving it needs no layout; it advances in those steps, each about a pixel.
 */
function Progress({ now }: { now: Now }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!now.isPlaying) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [now.isPlaying]);
  const pos = positionOf(now);
  const { durationMs } = now.track;
  return (
    <div className="np-progress">
      <div className="bar" role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((pos / durationMs) * 100)}>
        <div className="bar-fill np-fill" style={{ transform: `scaleX(${pos / durationMs})` }} />
      </div>
      <div className="np-times"><span>{fmt(pos)}</span><span>{fmt(durationMs)}</span></div>
    </div>
  );
}

/** Index of the lyric line being sung (-1 before the first), woken exactly when the next line starts. */
function useActiveLine(lines: { t: number }[], now: Now): number {
  const [active, setActive] = useState(() => lines.findLastIndex((l) => l.t <= positionOf(now)));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const pos = positionOf(now);
      const i = lines.findLastIndex((l) => l.t <= pos);
      setActive(i);
      const next = lines[i + 1];
      if (now.isPlaying && next) timer = setTimeout(step, Math.max(20, next.t - pos));
    };
    step();
    return () => clearTimeout(timer);
  }, [lines, now]);
  return active;
}

/** Fullscreen state for an element, plus an "idle" flag that hides chrome when the pointer rests (fullscreen or not). */
function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const onChange = () => setActive(document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);

  useEffect(() => {
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
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void ref.current?.requestFullscreen().catch(() => {});
  };

  return { active, idle, toggle };
}

export function NowPlaying({ now }: { now: Now | null }) {
  const track = now?.track ?? null;
  const palette = usePalette(track?.imageS);
  const [lyrics, setLyrics] = useState<Lyrics | 'loading' | null>(null);
  // The lyrics say more about the language than a short title does, so they are read along with it.
  const words = lyrics && lyrics !== 'loading' ? (lyrics.plain ?? lyrics.synced?.map((l) => l.text).join(' ')) : null;
  const lang = track ? langOf(track.name, track.artists, track.album, words) : undefined;
  // The cover floats by default; clicking it turns that off (remembered in this browser).
  const [floating, setFloating] = useState(() => {
    try { return localStorage.getItem(FLOAT_KEY) !== 'off'; } catch { return true; }
  });
  const toggleFloating = () => {
    setFloating((on) => {
      try { localStorage.setItem(FLOAT_KEY, on ? 'off' : 'on'); } catch { /* storage unavailable */ }
      return !on;
    });
  };
  const [scale, setScale] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SCALE_KEY));
      return saved > 0 ? clampScale(saved) : 1;
    } catch { return 1; }
  });
  useEffect(() => {
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* storage unavailable */ }
  }, [scale]);
  const resize = (steps: number) => setScale((s) => clampScale(s + steps * SCALE_STEP));
  const rootRef = useRef<HTMLDivElement>(null);
  const fs = useFullscreen(rootRef);

  // Standby: fullscreen, nothing playing, and nobody touching the mouse for a while.
  const stopped = !now || !now.isPlaying;
  const [standby, setStandby] = useState(false);
  useEffect(() => {
    if (!fs.active || !fs.idle || !stopped) { setStandby(false); return; }
    const id = setTimeout(() => setStandby(true), STANDBY_DELAY_MS);
    return () => clearTimeout(id);
  }, [fs.active, fs.idle, stopped]);

  // "F" toggles fullscreen (Esc is handled by the browser); "-" / "+" resize the cover and "0" resets it.
  // With Ctrl/Cmd held those keys are the browser's own zoom, so they are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === '-' || e.key === '_') resize(-1);
      else if (e.key === '=' || e.key === '+') resize(1);
      else if (e.key === '0') setScale(1);
      else if (!e.repeat && e.key.toLowerCase() === 'f') fs.toggle();
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

  const style = { '--ground': palette.ground, '--soft': palette.soft, '--point': palette.point, '--cover-scale': scale } as CSSProperties;

  return (
    <div ref={rootRef} className={'np' + (fs.active ? ' is-fs' : '') + (fs.idle ? ' is-idle' : '')} style={style}>
      {track?.imageM && <img className="blob-a" src={track.imageM} alt="" key={track.imageM} />}
      <div className="blob-b" aria-hidden="true" />
      <div className="np-veil" aria-hidden="true" />

      {standby && <Standby />}

      <div className="np-wrap">
        <header className="np-header">
          <a className="back" href="#/" aria-label="Back to calendar">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          </a>
          <div className="np-tools">
            <button className="fs-btn" aria-label="Smaller cover" title="Smaller cover (-)" disabled={scale <= SCALE_MIN} onClick={() => resize(-1)}>
              <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /></svg>
            </button>
            <button className="fs-btn" aria-label="Larger cover" title="Larger cover (+)" disabled={scale >= SCALE_MAX} onClick={() => resize(1)}>
              <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5v14" /></svg>
            </button>
            <button className="fs-btn" aria-label={fs.active ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fs.active} onClick={fs.toggle}>
              <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {fs.active ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
              </svg>
            </button>
          </div>
        </header>

        {!now || !track ? (
          <main className="np-idle">
            <h1>Nothing is playing right now</h1>
            <p>Start something on Spotify and this screen takes on the colour of its album.</p>
          </main>
        ) : (
          <main className="np-main">
              <section className="np-left" aria-label="Current track">
                <button
                  className={'cover-btn' + (floating ? ' is-floating' : '') + (now.isPlaying ? '' : ' is-paused')}
                  aria-pressed={floating}
                  aria-label="Floating cover motion"
                  title={floating ? 'Click to keep the cover still' : 'Click to let the cover float'}
                  onClick={toggleFloating}
                >
                  {track.imageL ? (
                    <img className="cover" src={track.imageL} alt={`${track.album} album cover`} key={track.imageL} />
                  ) : (
                    <div className="cover cover-blank" role="img" aria-label="No album cover" />
                  )}
                </button>
                <div className="np-titles">
                  <h1 lang={lang}>{track.name}</h1>
                  <div className="np-artist" lang={lang}>{track.artists}</div>
                  <div className="np-album" lang={lang}>{track.album}</div>
                </div>
                <Progress now={now} />
              </section>

              <section className="np-right" aria-label="Lyrics" lang={lang}>
                <LyricsView lyrics={lyrics} now={now} />
              </section>
            </main>
        )}
      </div>
    </div>
  );
}

function LyricsView({ lyrics, now }: { lyrics: Lyrics | 'loading' | null; now: Now }) {
  // No lyrics, an instrumental, or still loading: leave the space empty.
  if (!lyrics || lyrics === 'loading' || lyrics.instrumental) return null;
  if (lyrics.synced) return <SyncedLyrics lines={lyrics.synced} now={now} />;
  if (lyrics.plain) return <div className="lyrics-plain">{lyrics.plain}</div>;
  return null;
}

/** Lines kept painted around the active one: what the lyrics box can show, plus one that is scrolling out or in. */
const LINES_ABOVE = 3;
const LINES_BELOW = 9;

function SyncedLyrics({ lines, now }: { lines: { t: number; text: string }[]; now: Now }) {
  const active = useActiveLine(lines, now);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
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
        {lines.map((l, i) => {
          const away = i - Math.max(0, active);
          // The box shows about two lines above the active one and seven below; the rest keep their place
          // in the layout but are not painted (each would be a blurred layer of its own).
          const style: CSSProperties =
            away < -LINES_ABOVE || away > LINES_BELOW ? { visibility: 'hidden' }
            : i === active ? {}
            : { filter: `blur(${Math.min(Math.abs(away) * 0.7, 3.5)}px)` };
          return (
            <div
              key={i}
              ref={(el) => { refs.current[i] = el; }}
              className={'line' + (i === active ? ' is-active' : i < active ? ' is-past' : '')}
              aria-current={i === active ? 'true' : undefined}
              style={style}
            >
              {l.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
