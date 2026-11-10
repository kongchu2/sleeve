import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getDayNotes, getPlays, type DayNotes, type Now, type Play } from './api.ts';
import { usePalette, usePoints } from './color.ts';
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

type AlbumGroup = DayAlbum & { artists: string; minutes: number; tracks: DayTrack[] };

/** A day's plays folded into one entry per album, most played first, each with its tracks in listening order. */
function groupsOf(plays: Play[]): AlbumGroup[] {
  return albumsOf(plays).map((album) => {
    const own = plays.filter((p) => p.album_id === album.id);
    return {
      ...album,
      artists: own[0].artists,
      minutes: Math.round(own.reduce((a, p) => a + p.duration_ms, 0) / 60_000),
      tracks: tracksOf(own),
    };
  });
}

const MIN_FULL_ALBUM_TRACKS = 4;

/**
 * Albums heard in full: every track of the album played in one unbroken run (any order, repeats allowed),
 * with no other album in between. Singles and short EPs are ignored. A run that crosses midnight
 * belongs to the day it started. Returns album ids per day of the month.
 */
function fullAlbumsByDay(plays: Play[]): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  let start = 0;
  for (let i = 1; i <= plays.length; i++) {
    if (i < plays.length && plays[i].album_id === plays[start].album_id) continue;
    const first = plays[start];
    const total = first.album_total_tracks ?? 0;
    if (total >= MIN_FULL_ALBUM_TRACKS) {
      const heard = new Set(plays.slice(start, i).map((p) => p.track_id));
      if (heard.size >= total) {
        const day = new Date(first.played_at).getDate();
        if (!out.has(day)) out.set(day, new Set());
        out.get(day)!.add(first.album_id);
      }
    }
    start = i;
  }
  return out;
}

function DiscIcon({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** "FULL ALBUM" marker tinted with the album's own point colour. */
function FullAlbumTag({ imageS }: { imageS: string | null }) {
  const point = usePalette(imageS).point;
  return (
    <span className="full-tag" style={{ color: point }}>
      <DiscIcon size={12} />
      FULL ALBUM
    </span>
  );
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

  useEffect(() => {
    let live = true;
    const load = () =>
      getPlays(new Date(ym.y, ym.m, 1).getTime(), new Date(ym.y, ym.m + 1, 1).getTime()).then(
        (rows) => { if (live) setPlays(rows); },
        () => {},
      );
    setPlays([]);
    void load();
    const id = isCurrentMonth ? setInterval(load, 60_000) : undefined;
    return () => { live = false; clearInterval(id); };
  }, [ym.y, ym.m, isCurrentMonth]);

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

  const fullByDay = useMemo(() => fullAlbumsByDay(plays), [plays]);

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
  const dayCovers = useMemo(
    () => Array.from({ length: daysInMonth }, (_, i) => albumsOf(byDay.get(i + 1) ?? [])[0]?.imageS ?? null),
    [byDay, daysInMonth],
  );
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

  return (
    <div className="page" style={{ '--accent': accent } as CSSProperties}>
      {selAlbums[0]?.image && <img className="ambient" src={selAlbums[0].image} alt="" key={selAlbums[0].image} />}
      <div className={'hover-bg' + (bg.on ? ' is-on' : '')} aria-hidden="true">
        {bg.prev && <img src={bg.prev} alt="" key={'p' + bg.prev} />}
        {bg.cur && <img className="hover-bg-cur" src={bg.cur} alt="" key={bg.cur} />}
      </div>
      <div className="wrap">
        <header className="cal-header">
          <div className="cal-title">
            <div className="mono-label">LISTENING LOG · {ym.y}</div>
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
              <a href="#/albums">Full albums</a>
              <a href={`#/recap/${ym.y}-${two(ym.m + 1)}`}>Recap</a>
              <a href="#/import">Import history</a>
            </nav>
          </div>
          {now && <NowPill now={now} />}
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
                const albums = albumsOf(byDay.get(d) ?? []).slice(0, 4);
                const full = fullByDay.get(d);
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
                    aria-label={`${MONTHS[ym.m]} ${d}, ${plural(albums.length, 'album')}${full?.size ? `, ${plural(full.size, 'full album')}` : ''}`}
                    aria-pressed={selected}
                    onClick={() => setPicked(d)}
                  >
                    {albums.map((a, k) => (
                      <span key={a.id} className="tile" onPointerEnter={() => showBg(a.image)} onPointerLeave={hideBg} style={{ gridColumn: MOSAIC[albums.length][k][0], gridRow: MOSAIC[albums.length][k][1] }}>
                        {a.image && <img src={a.image} alt="" loading="lazy" />}
                        {full?.has(a.id) && <span className="full-badge" title="Full album"><DiscIcon size={12} /></span>}
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

            {notes && (notes.streak || notes.onThisDay.length > 0) && (
              <div className="notes">
                {notes.streak && (
                  <div className="note">
                    <span className="note-label">{notes.streak.days} days in a row</span>
                    <span className="note-text">{notes.streak.album}</span>
                  </div>
                )}
                {notes.onThisDay.slice(0, 2).map((o) => (
                  <a className="note" key={o.year} href={`#/day/${o.day}`}>
                    <span className="note-label">{ym.y - o.year === 1 ? 'A year ago today' : `${ym.y - o.year} years ago today`}</span>
                    <span className="note-text">
                      {o.image_s && <img src={o.image_s} alt="" loading="lazy" />}
                      {o.album}
                    </span>
                  </a>
                ))}
              </div>
            )}

            {selIsToday && now && (
              <a className="now-cta" href="#/now">
                <span>See what's playing now</span>
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </a>
            )}

            {selTracks.length > 0 ? (
              <>
                <div className="hours">
                  <div className="hours-bars" aria-hidden="true">
                    {hourImages.map((u, h) => <span key={h} style={u ? { background: points[u] ?? '#3A3A44' } : undefined} />)}
                  </div>
                  <div className="hours-labels" aria-hidden="true">
                    <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
                  </div>
                </div>
                <div className="albums">
                  {selGroups.map((g) => {
                    const open = openKey === dayKey + g.id;
                    return (
                      <div className={'album' + (open ? ' is-open' : '')} key={g.id} onPointerEnter={() => showBg(g.image)} onPointerLeave={hideBg}>
                        <button className="album-row" aria-expanded={open} onClick={() => setOpenKey(open ? null : dayKey + g.id)}>
                          {g.imageS ? <img className="track-art" src={g.imageS} alt="" loading="lazy" /> : <span className="track-art" />}
                          <span className="track-text">
                            <span className="track-name">{g.name}</span>
                            <span className="track-sub">{g.artists}</span>
                          </span>
                          <span className="track-side">
                            {fullByDay.get(sel)?.has(g.id) ? <FullAlbumTag imageS={g.imageS} /> : <span>{plural(g.tracks.length, 'track')}</span>}
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
                                  <span className="album-track-name">{t.name}</span>
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

function NowPill({ now }: { now: Now }) {
  const point = usePalette(now.track.imageS).point;
  return (
    <a className="pill" href="#/now" style={{ '--point': point } as CSSProperties}>
      {now.track.imageS ? <img className="pill-art" src={now.track.imageS} alt="" /> : <span className="pill-art" />}
      <span className="pill-text">
        <span className="pill-label">{now.isPlaying ? 'NOW PLAYING' : 'PAUSED'}</span>
        <span className="pill-title">{now.track.name} — {now.track.artists}</span>
      </span>
      <span className={'eq' + (now.isPlaying ? '' : ' is-paused')} aria-hidden="true"><span /><span /><span /></span>
    </a>
  );
}
