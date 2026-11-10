import { useEffect, useState, type CSSProperties } from 'react';
import { getRecap, type Recap } from './api.ts';
import { usePalette } from './color.ts';
import { MONTHS } from './shared.tsx';

const two = (n: number) => String(n).padStart(2, '0');

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}

/** One sheet summing up a month: its top album, how much was played, and when. */
export function RecapView({ year, month }: { year: number; month: number }) {
  const [recap, setRecap] = useState<Recap | null>(null);

  useEffect(() => {
    let live = true;
    getRecap(new Date(year, month, 1).getTime(), new Date(year, month + 1, 1).getTime()).then(
      (r) => { if (live) setRecap(r); },
      () => {},
    );
    return () => { live = false; };
  }, [year, month]);

  const top = recap?.topAlbums[0];
  const palette = usePalette(top?.image_s);
  const now = new Date();
  const unfinished = year === now.getFullYear() && month === now.getMonth();
  const maxHour = recap ? Math.max(1, ...recap.hours) : 1;
  const back = `#/day/${year}-${two(month + 1)}-01`;

  return (
    <div className="page recap" style={{ '--accent': palette.point, '--ground': palette.ground } as CSSProperties}>
      {top?.image_m && <img className="recap-bg" src={top.image_m} alt="" key={top.image_m} />}
      <div className="wrap">
        <header className="cal-title">
          <a className="back back-inline" href={back} aria-label="Back to the calendar">
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
          </a>
          <div className="mono-label">RECAP · {year}{unfinished && ' · SO FAR'}</div>
          <h1 className="page-title">{MONTHS[month]}</h1>
        </header>

        {recap && recap.plays === 0 && <p className="recap-empty">Nothing was logged this month.</p>}

        {recap && top && (
          <main className="recap-sheet">
            <section className="recap-top" aria-label="Most played album">
              {top.image_m ? <img className="recap-cover" src={top.image_m} alt={`${top.name} album cover`} /> : <div className="recap-cover" />}
              <div className="recap-top-text">
                <div className="mono-label">MOST PLAYED ALBUM</div>
                <div className="recap-album">{top.name}</div>
                <div className="recap-artist">{top.artists} · {top.plays} plays</div>
              </div>
            </section>

            <section className="recap-side">
              <dl className="recap-stats">
                <div><dt>Plays</dt><dd>{recap.plays.toLocaleString('en')}</dd></div>
                <div><dt>Listening time</dt><dd>{duration(recap.minutes)}</dd></div>
                <div><dt>Days with music</dt><dd>{recap.days}</dd></div>
                <div><dt>Albums</dt><dd>{recap.albums}</dd></div>
                <div><dt>Full albums</dt><dd>{recap.fullAlbums}</dd></div>
                <div><dt>Top artist</dt><dd className="recap-small">{recap.topArtists[0]?.name ?? '—'}</dd></div>
              </dl>

              {recap.peakHour !== null && (
                <section className="recap-hours" aria-label="Plays by hour of day">
                  <div className="recap-hours-head">
                    <span className="mono-label">BUSIEST HOUR</span>
                    <span className="recap-peak">{two(recap.peakHour)}:00</span>
                  </div>
                  <div className="recap-bars" role="img" aria-label={`Most plays around ${two(recap.peakHour)}:00`}>
                    {recap.hours.map((n, h) => (
                      <span key={h} className={h === recap.peakHour ? 'is-peak' : undefined} style={{ height: Math.max(4, (n / maxHour) * 100) + '%' }} title={`${two(h)}:00 — ${n} plays`} />
                    ))}
                  </div>
                  <div className="hours-labels" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
                </section>
              )}

              {recap.topAlbums.length > 1 && (
                <section aria-label="Next most played albums">
                  <div className="mono-label recap-list-title">ALSO ON REPEAT</div>
                  {recap.topAlbums.slice(1).map((a, i) => (
                    <div className="recap-row" key={a.id}>
                      <span className="recap-rank">{i + 2}</span>
                      {a.image_s ? <img className="track-art" src={a.image_s} alt="" loading="lazy" /> : <span className="track-art" />}
                      <span className="track-text">
                        <span className="track-name">{a.name}</span>
                        <span className="track-sub">{a.artists}</span>
                      </span>
                      <span className="track-side"><span>{a.plays}</span></span>
                    </div>
                  ))}
                </section>
              )}
            </section>
          </main>
        )}
      </div>
    </div>
  );
}
