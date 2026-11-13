import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getDayNotes, getPlays, type DayNotes, type Now, type Play } from './api.ts';
import { usePalette, usePoints } from './color.ts';
import { langOf } from './lang.ts';
import { MONTHS } from './shared.tsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const MOSAIC: Record<number, [string, string][]> = {
  1: [['1 / 3', '1 / 3']],
  2: [['1', '1 / 3'], ['2', '1 / 3']],
  3: [['1', '1 / 3'], ['2', '1'], ['2', '2']],
  4: [['1', '1'], ['2', '1'], ['1', '2'], ['2', '2']],
};

type DayAlbum = { id: string; name: string; image: string | null; imageS: string | null; count: number };
type DayTrack = { id: string; name: string; sub: string; image: string | null; imageS: string | null; count: number; first: number };

/** Albums of a day, most played first. */
function albumsOf(plays: Play[]): DayAlbum[] {
  const map = new Map<string, DayAlbum>();
  for (const p of plays) {
    const a = map.get(p.album_id);
    if (a) a.count += 1;
    else map.set(p.album_id, { id: p.album_id, name: p.album_name, image: p.image_m, imageS: p.image_s, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Tracks of a day in the order they were first heard. */
function tracksOf(plays: Play[]): DayTrack[] {
  const map = new Map<string, DayTrack>();
  for (const p of plays) {
    const t = map.get(p.track_id);
    if (t) t.count += 1;
    else
      map.set(p.track_id, {
        id: p.track_id,
        name: p.track_name,
        sub: p.artists + ' · ' + p.album_name,
        image: p.image_m,
        imageS: p.image_s,
        count: 1,
        first: p.played_at,
      });
  }
  return [...map.values()].sort((a, b) => a.first - b.first);
}

type AlbumGroup = DayAlbum & { artists: string; minutes: number; tracks: DayTrack[]; last: number };

/** A day's plays folded into one entry per album, most recently played first, each with its tracks newest first. */
function groupsOf(plays: Play[]): AlbumGroup[] {
  return albumsOf(plays)
    .map((album) => {
      const own = plays.filter((p) => p.album_id === album.id);
      return {
        ...album,
        artists: own[0].artists,
        minutes: Math.round(own.reduce((a, p) => a + p.duration_ms, 0) / 60_000),
        tracks: tracksOf(own).reverse(),
        last: Math.max(...own.map((p) => p.played_at)),
      };
    })
    .sort((a, b) => b.last - a.last);
}

const two = (n: number) => String(n).padStart(2, '0');

export function Calendar({ now, initial }: { now: Now | null; initial?: { y: number; m: number; d: number } }) {
  const today = new Date();
  const [ym, setYm] = useState(initial ? { y: initial.y, m: initial.m } : { y: today.getFullYear(), m: today.getMonth() });
  const [picked, setPicked] = useState<number | null>(initial?.d ?? null);
  const [plays, setPlays] = useState<Play[]>([]);
  // Hovered cover, painted across the whole page. `prev` stays underneath so covers cross-fade.
  const [bg, setBg] = useState<{ cur: string | null; prev: string | null; on: boolean }>({ cur: null, prev: null, on: false });
  const showBg = (url: string | null) => {
    if (url) setBg((b) => (b.cur === url ? { ...b, on: true } : { cur: url, prev: b.cur, on: true }));
  };
  const hideBg = () => setBg((b) => ({ ...b, on: false }));

  const isCurrentMonth = ym.y === today.getFullYear() && ym.m === today.getMonth();
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
  const firstWeekday = new Date(ym.y, ym.m, 1).getDay();
  const lastPastDay = isCurrentMonth ? today.getDate() : daysInMonth;

  // The month is fetched whole once; after that only plays newer than the newest one already here are
  // asked for and appended, so a refresh that finds nothing costs nothing and re-renders nothing.
  const monthStart = new Date(ym.y, ym.m, 1).getTime();
  const monthEnd = new Date(ym.y, ym.m + 1, 1).getTime();
  const loaded = useRef({ month: monthStart, newest: monthStart - 1 });
  const load = useCallback(
    () =>
      getPlays(loaded.current.newest + 1, monthEnd).then(
        (rows) => {
          const state = loaded.current;
          if (state.month !== monthStart) return; // an answer for a month since left
          const fresh = rows.filter((r) => r.played_at > state.newest); // two requests can overlap
          if (!fresh.length) return;
          state.newest = fresh[fresh.length - 1].played_at;
          setPlays((prev) => [...prev, ...fresh]);
        },
        () => {},
      ),
    [monthStart, monthEnd],
  );

  useEffect(() => {
    loaded.current = { month: monthStart, newest: monthStart - 1 };
    setPlays([]);
    void load();
    if (!isCurrentMonth) return;
    // A hidden tab does not ask; it catches up when it is shown again.
    const refresh = () => { if (!document.hidden) void load(); };
    const id = setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', refresh); };
  }, [load, monthStart, isCurrentMonth]);

  // A track change means the previous track just ended and the server is pulling it into the history:
  // ask shortly after (twice, as Spotify can be slow to list it) rather than waiting for the minute tick.
  const nowId = now?.track.id ?? null;
  useEffect(() => {
    if (!isCurrentMonth) return;
    const timers = [setTimeout(load, 8_000), setTimeout(load, 35_000)];
    return () => timers.forEach(clearTimeout);
  }, [nowId, load, isCurrentMonth]);

  const byDay = useMemo(() => {
    const map = new Map<number, Play[]>();
    for (const p of plays) {
      const d = new Date(p.played_at).getDate();
      const list = map.get(d);
      if (list) list.push(p);
      else map.set(d, [p]);
    }
    return map;
  }, [plays]);

  // Default selection: today in the current month, otherwise the last day with music.
  const sel = picked ?? (isCurrentMonth ? today.getDate() : Math.max(1, ...byDay.keys()));
  const selPlays = byDay.get(sel) ?? [];
  const selAlbums = useMemo(() => albumsOf(selPlays), [selPlays]);
  const selTracks = useMemo(() => tracksOf(selPlays), [selPlays]);
  const selGroups = useMemo(() => groupsOf(selPlays), [selPlays]);
  // Expanded album, keyed with the date so it resets when another day is picked.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const dayKey = `${ym.y}-${ym.m}-${sel}:`;
  const accent = usePalette(selAlbums[0]?.imageS).point;

  const hourImages = useMemo(() => {
    const hours: (string | null)[] = Array(24).fill(null);
    for (const p of selPlays) {
      const h = new Date(p.played_at).getHours();
      hours[h] ??= p.image_s;
    }
    return hours;
  }, [selPlays]);
  const points = usePoints(useMemo(() => [...new Set(hourImages.filter((u): u is string => !!u))], [hourImages]));

  // The month's colour flow: one swatch per day, tinted by that day's most played album.
  const dayAlbums = useMemo(
    () => Array.from({ length: daysInMonth }, (_, i) => albumsOf(byDay.get(i + 1) ?? [])),
    [byDay, daysInMonth],
  );
  const dayCovers = useMemo(() => dayAlbums.map((albums) => albums[0]?.imageS ?? null), [dayAlbums]);
  const dayColors = usePoints(useMemo(() => [...new Set(dayCovers.filter((u): u is string => !!u))], [dayCovers]));

  // Streak and "on this day" for the selected date.
  const selKey = `${ym.y}-${two(ym.m + 1)}-${two(sel)}`;
  const [notes, setNotes] = useState<DayNotes | null>(null);
  const selPlayCount = selPlays.length;
  useEffect(() => {
    let live = true;
    setNotes(null);
    getDayNotes(selKey).then((n) => { if (live) setNotes(n); }, () => {});
    return () => { live = false; };
  }, [selKey, selPlayCount]);

  const minutes = Math.round(selPlays.reduce((a, p) => a + p.duration_ms, 0) / 60_000);
  const selIsToday = isCurrentMonth && sel === today.getDate();

  const go = (delta: number) => {
    const d = new Date(ym.y, ym.m + delta, 1);
    setYm({ y: d.getFullYear(), m: d.getMonth() });
    setPicked(null);
  };

  // The resting backdrop: what is playing now, or else the selected day's most played album.
  const ambient = now?.track.imageM ?? now?.track.imageS ?? selAlbums[0]?.image;

  return (
    <div className="page" style={{ '--accent': accent } as CSSProperties}>
      {ambient && <img className="ambient" src={ambient} alt="" key={ambient} />}
      <div className={'hover-bg' + (bg.on ? ' is-on' : '')} aria-hidden="true">
        {bg.prev && <img src={bg.prev} alt="" key={'p' + bg.prev} />}
        {bg.cur && <img className="hover-bg-cur" src={bg.cur} alt="" key={bg.cur} />}
      </div>
      <div className="wrap">
        <header className="cal-header">
          <div className="cal-title">
            <div className="mono-label">SLEEVE · {ym.y}</div>
            <div className="cal-title-row">
              <h1>{MONTHS[ym.m]}</h1>
              <div className="nav-group">
                <button className="nav" aria-label="Previous month" onClick={() => go(-1)}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
                </button>
                <button className="nav" aria-label="Next month" onClick={() => go(1)} disabled={isCurrentMonth}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
            <div className="cal-summary">
              {plays.length ? `${plural(plays.length, 'play')} across ${plural(byDay.size, 'day')}` : 'Nothing logged this month yet'}
            </div>
            <nav className="cal-links" aria-label="More views">
              <a href="#/year">Year</a>
              <a href={`#/recap/${ym.y}-${two(ym.m + 1)}`}>Recap</a>
              <a href="#/import">Import history</a>
            </nav>
          </div>
        </header>

        <main className="cal-main">
          <section className="cal-grid-col" aria-label="Calendar">
            <div className="flow" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${daysInMonth}, minmax(0, 1fr))` }}>
              {dayCovers.map((u, i) => (
                <span key={i} className={i + 1 === sel ? 'is-selected' : undefined} style={u ? { background: dayColors[u] ?? '#3A3A44' } : undefined} />
              ))}
            </div>
            <div className="weekdays" aria-hidden="true">
              {WEEKDAYS.map((w) => <div key={w}>{w.slice(0, 3)}</div>)}
            </div>
            <div className="grid" key={`${ym.y}-${ym.m}`}>
              {Array.from({ length: firstWeekday }, (_, i) => <div key={'b' + i} aria-hidden="true" />)}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const d = i + 1;
                if (d > lastPastDay) return <div key={d} className="day-future">{d}</div>;
                const albums = dayAlbums[i].slice(0, 4);
                const selected = d === sel;
                if (!albums.length)
                  return (
                    <button key={d} className={'day day-empty' + (selected ? ' is-selected' : '')} aria-label={`${MONTHS[ym.m]} ${d}, nothing played`} aria-pressed={selected} onClick={() => setPicked(d)}>
                      {d}
                    </button>
                  );
                return (
                  <button
                    key={d}
                    className={'day day-filled' + (selected ? ' is-selected' : '')}
                    style={{ animationDelay: d * 18 + 'ms' }}
                    aria-label={`${MONTHS[ym.m]} ${d}, ${plural(albums.length, 'album')}`}
                    aria-pressed={selected}
                    onClick={() => setPicked(d)}
                  >
                    {albums.map((a, k) => (
                      <span key={a.id} className="tile" onPointerEnter={() => showBg(a.image)} onPointerLeave={hideBg} style={{ gridColumn: MOSAIC[albums.length][k][0], gridRow: MOSAIC[albums.length][k][1] }}>
                        {a.image && <img src={a.image} alt="" loading="lazy" />}
                      </span>
                    ))}
                    <span className="day-num">{d}</span>
                    {isCurrentMonth && d === today.getDate() && now?.isPlaying && <span className="live" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="day-panel" aria-label="Selected day">
            <div className="day-panel-inner">
            <div className="day-head">
              <div className="day-big">{two(sel)}</div>
              <div className="day-meta">
                <div className="day-weekday">{WEEKDAYS[new Date(ym.y, ym.m, sel).getDay()]}</div>
                <div className="mono-label">
                  {selTracks.length ? `${selTracks.length} TRACKS · ${minutes} MIN` : 'SILENT DAY'}
                </div>
              </div>
            </div>

            {selTracks.length > 0 && (
              <div className="hours">
                <div className="hours-bars" aria-hidden="true">
                  {hourImages.map((u, h) => <span key={h} style={u ? { background: points[u] ?? '#3A3A44' } : undefined} />)}
                </div>
                <div className="hours-labels" aria-hidden="true">
                  <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
                </div>
              </div>
            )}

            {notes && (notes.streak || notes.onThisDay.length > 0) && (
              <div className="notes">
                {notes.streak && (
                  <div className="note">
                    <span className="note-label">{notes.streak.days} days in a row</span>
                    <span className="note-text" lang={langOf(notes.streak.album)}>{notes.streak.album}</span>
                  </div>
                )}
                {notes.onThisDay.slice(0, 2).map((o) => (
                  <a className="note" key={o.year} href={`#/day/${o.day}`}>
                    <span className="note-label">{ym.y - o.year === 1 ? 'A year ago today' : `${ym.y - o.year} years ago today`}</span>
                    <span className="note-text" lang={langOf(o.album)}>
                      {o.image_s && <img src={o.image_s} alt="" loading="lazy" />}
                      {o.album}
                    </span>
                  </a>
                ))}
              </div>
            )}

            {now && <NowCard now={now} />}

            {selTracks.length > 0 ? (
              <>
                <div className="albums">
                  {selGroups.map((g) => {
                    const open = openKey === dayKey + g.id;
                    const lang = langOf(g.name, g.artists, ...g.tracks.map((t) => t.name));
                    return (
                      <div className={'album' + (open ? ' is-open' : '')} key={g.id} onPointerEnter={() => showBg(g.image)} onPointerLeave={hideBg}>
                        <button className="album-row" aria-expanded={open} onClick={() => setOpenKey(open ? null : dayKey + g.id)}>
                          {g.imageS ? <img className="track-art" src={g.imageS} alt="" loading="lazy" /> : <span className="track-art" />}
                          <span className="track-text">
                            <span className="track-name" lang={lang}>{g.name}</span>
                            <span className="track-sub" lang={lang}>{g.artists}</span>
                          </span>
                          <span className="track-side">
                            <span>{plural(g.tracks.length, 'track')}</span>
                            <span className="dim">{g.minutes} min</span>
                          </span>
                          <svg className="album-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        {open && (
                          <div className="album-tracks">
                            {g.tracks.map((t) => {
                              const at = new Date(t.first);
                              return (
                                <div className="album-track" key={t.id}>
                                  <span className="album-track-time">{two(at.getHours())}:{two(at.getMinutes())}</span>
                                  <span className="album-track-name" lang={lang}>{t.name}</span>
                                  {t.count > 1 && <span className="album-track-count">×{t.count}</span>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="silent">
                Nothing played on this day.<br />Quiet days are part of the record too.
              </div>
            )}
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}

/** What is playing right now: a row pinned above the album list (it does not scroll with it), a size larger and in the cover's colour; opens the Now Playing screen. */
function NowCard({ now }: { now: Now }) {
  const { track } = now;
  const point = usePalette(track.imageS).point;
  // Re-render every second while playing so the progress line keeps moving between polls.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!now.isPlaying) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [now.isPlaying]);
  const elapsed = Math.min(track.durationMs, now.isPlaying ? now.progressMs + (Date.now() - now.receivedAt) : now.progressMs);
  const art = track.imageM ?? track.imageS;
  const lang = langOf(track.name, track.artists, track.album);
  return (
    <a className="now-row" href="#/now" aria-label={`Open Now Playing: ${track.name} by ${track.artists}`} style={{ '--point': point } as CSSProperties}>
      {art ? <img className="now-row-art" src={art} alt="" /> : <span className="now-row-art" />}
      <span className="track-text">
        <span className="now-row-state">
          <span className={'now-row-eq' + (now.isPlaying ? '' : ' is-paused')} aria-hidden="true"><span /><span /><span /></span>
          {now.isPlaying ? 'NOW PLAYING' : 'PAUSED'}
        </span>
        <span className="now-row-name" lang={lang}>{track.name}</span>
        <span className="track-sub" lang={lang}>{track.artists}</span>
      </span>
      <svg className="now-row-go" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      <span className="now-row-bar" aria-hidden="true" style={{ width: (elapsed / track.durationMs) * 100 + '%' }} />
    </a>
  );
}
