import { useEffect, useMemo, useState } from 'react';
import { getWall } from './api.ts';
import { MONTHS } from './shared.tsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The wall is drawn slightly larger than the screen so its slow pan never shows an edge. */
const OVERSCAN = 1.08;
const two = (n: number) => String(n).padStart(2, '0');

type Size = { w: number; h: number };
const screenSize = (): Size => ({ w: innerWidth, h: innerHeight });

/** Columns and rows of square tiles that cover the screen with tiles at least `tile` px wide. */
function grid({ w, h }: Size, tile: number) {
  const cols = Math.max(1, Math.ceil((w * OVERSCAN) / tile));
  const actual = (w * OVERSCAN) / cols;
  return { cols, rows: Math.max(1, Math.ceil((h * OVERSCAN) / actual)) };
}

const preferredTile = (size: Size) => Math.min(170, Math.max(96, size.w * 0.085));

/**
 * Lay out `count` covers without repeating any: start from the preferred tile size and
 * enlarge the tiles until the grid needs no more covers than there are.
 */
function fit(size: Size, count: number) {
  let tile = preferredTile(size);
  let g = grid(size, tile);
  while (count > 0 && g.cols * g.rows > count && g.cols > 1) {
    tile *= 1.03;
    g = grid(size, tile);
  }
  return g;
}

/**
 * Always-on screen for a spare display: a clock over a wall of album covers.
 * The wall shows the most played albums of the last month, each once; when a month is not
 * enough to fill the screen the server looks further back (up to 36 months).
 * Shown over the player while it is fullscreen and nothing is playing.
 */
export function Standby() {
  const [now, setNow] = useState(() => new Date());
  const [size, setSize] = useState(screenSize);
  const [covers, setCovers] = useState<string[]>([]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    const onResize = () => setSize(screenSize());
    addEventListener('resize', onResize);
    return () => { clearInterval(id); removeEventListener('resize', onResize); };
  }, []);

  // Ask for exactly as many covers as the screen holds; refreshed when that or the date changes.
  const wanted = useMemo(() => { const g = grid(size, preferredTile(size)); return g.cols * g.rows; }, [size]);
  const dayKey = now.toDateString();
  useEffect(() => {
    let live = true;
    getWall(wanted).then((wall) => { if (live) setCovers(wall.covers); }, () => {});
    return () => { live = false; };
  }, [wanted, dayKey]);

  const layout = useMemo(() => fit(size, covers.length), [size, covers.length]);
  const shown = covers.slice(0, layout.cols * layout.rows);

  return (
    <div className="standby" role="img" aria-label={`${two(now.getHours())}:${two(now.getMinutes())}`}>
      <div className="standby-wall" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}>
        {shown.map((src) => (
          <span className="standby-tile" key={src}>
            <img src={src} alt="" />
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
