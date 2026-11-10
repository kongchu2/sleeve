import { useEffect, useMemo, useState } from 'react';
import { getDays, getPlays } from './api.ts';
import { MONTHS } from './shared.tsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;
const two = (n: number) => String(n).padStart(2, '0');

type Cell = { image: string; label: string | null };

/** Columns and rows of square tiles needed to cover the screen (plus a margin for the slow pan). */
function gridSize() {
  const tile = Math.min(170, Math.max(96, innerWidth * 0.085));
  return { cols: Math.ceil((innerWidth * 1.08) / tile), rows: Math.ceil((innerHeight * 1.08) / tile) + 1 };
}

/**
 * Always-on screen for a spare display: a clock over a wall of album covers.
 * The wall is the calendar laid end to end, newest first: one tile per day with music,
 * showing that day's most played album. Until there are enough days to fill the screen,
 * the rest is filled with other recently played albums.
 * Shown over the player while it is fullscreen and nothing is playing.
 */
export function Standby() {
  const [now, setNow] = useState(() => new Date());
  const [days, setDays] = useState<Cell[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const [size, setSize] = useState(gridSize);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    const onResize = () => setSize(gridSize());
    addEventListener('resize', onResize);
    return () => { clearInterval(id); removeEventListener('resize', onResize); };
  }, []);

  // Refreshed when the date changes.
  const dayKey = now.toDateString();
  useEffect(() => {
    let live = true;
    const end = Date.now();
    getDays(end - 400 * DAY_MS, end).then(
      (rows) => {
        if (!live) return;
        setDays(
          rows.reverse().filter((d) => d.image_m).map((d) => {
            const [, m, day] = d.day.split('-').map(Number);
            return { image: d.image_m!, label: `${MONTHS[m - 1].slice(0, 3)} ${day}` };
          }),
        );
      },
      () => {},
    );
    getPlays(end - 14 * DAY_MS, end).then(
      (plays) => { if (live) setExtras([...new Set(plays.reverse().map((p) => p.image_m).filter((u): u is string => !!u))]); },
      () => {},
    );
    return () => { live = false; };
  }, [dayKey]);

  const cells = useMemo(() => {
    const wanted = size.cols * size.rows;
    const out: Cell[] = days.slice(0, wanted);
    const shown = new Set(out.map((c) => c.image));
    // Prefer covers not on the wall yet, then repeat as needed.
    const fill = [...extras.filter((u) => !shown.has(u)), ...extras];
    for (let i = 0; out.length < wanted && fill.length; i++) out.push({ image: fill[i % fill.length], label: null });
    return out;
  }, [days, extras, size]);

  return (
    <div className="standby" role="img" aria-label={`${two(now.getHours())}:${two(now.getMinutes())}`}>
      <div className="standby-wall" style={{ gridTemplateColumns: `repeat(${size.cols}, minmax(0, 1fr))` }}>
        {cells.map((c, i) => (
          <span className="standby-tile" key={i}>
            <img src={c.image} alt="" />
            {c.label && <span className="standby-tile-label">{c.label}</span>}
          </span>
        ))}
      </div>
      <div className="standby-clock">
        <div className="standby-time">{two(now.getHours())}:{two(now.getMinutes())}</div>
        <div className="standby-date">{WEEKDAYS[now.getDay()]}, {MONTHS[now.getMonth()]} {now.getDate()}</div>
      </div>
    </div>
  );
}
