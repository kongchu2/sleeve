import { useEffect, useMemo, useState } from 'react';
import { getDays, type DaySummary } from './api.ts';
import { BackLink, MONTHS } from './shared.tsx';

const two = (n: number) => String(n).padStart(2, '0');

/** A whole year at a glance: twelve small months, each day showing its most played album. */
export function YearView() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [days, setDays] = useState<DaySummary[]>([]);

  useEffect(() => {
    let live = true;
    setDays([]);
    getDays(new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime()).then(
      (rows) => { if (live) setDays(rows); },
      () => {},
    );
    return () => { live = false; };
  }, [year]);

  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const plays = days.reduce((a, d) => a + d.plays, 0);
  const isCurrentYear = year === today.getFullYear();
  const todayKey = `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`;

  return (
    <div className="page">
      <div className="wrap">
        <header className="cal-header">
          <div className="cal-title">
            <BackLink />
            <div className="cal-title-row">
              <h1>{year}</h1>
              <div className="nav-group">
                <button className="nav" aria-label="Previous year" onClick={() => setYear(year - 1)}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
                </button>
                <button className="nav" aria-label="Next year" onClick={() => setYear(year + 1)} disabled={isCurrentYear}>
                  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
            </div>
            <div className="cal-summary">
              {days.length ? `${plays.toLocaleString('en')} plays across ${days.length} day${days.length === 1 ? '' : 's'}` : 'Nothing logged this year'}
            </div>
          </div>
        </header>

        <main className="year-grid">
          {MONTHS.map((name, m) => {
            const first = new Date(year, m, 1).getDay();
            const count = new Date(year, m + 1, 0).getDate();
            return (
              <section className="year-month" key={name} aria-label={name}>
                <h2 className="mono-label">{name.slice(0, 3).toUpperCase()}</h2>
                <div className="year-days">
                  {Array.from({ length: first }, (_, i) => <span key={'b' + i} />)}
                  {Array.from({ length: count }, (_, i) => {
                    const key = `${year}-${two(m + 1)}-${two(i + 1)}`;
                    const day = byDay.get(key);
                    if (!day) return <span key={key} className={'yd' + (key > todayKey ? ' is-future' : '')} />;
                    const label = `${name} ${i + 1}: ${day.album}, ${day.plays} play${day.plays === 1 ? '' : 's'}`;
                    return (
                      <a key={key} className="yd yd-filled" href={`#/day/${key}`} title={label} aria-label={label}>
                        {day.image_s && <img src={day.image_s} alt="" loading="lazy" />}
                      </a>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </main>
      </div>
    </div>
  );
}
