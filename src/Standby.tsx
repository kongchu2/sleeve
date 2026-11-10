import { useEffect, useState, type CSSProperties } from 'react';
import { getPlays } from './api.ts';
import { MONTHS } from './shared.tsx';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_COVERS = 14;
const two = (n: number) => String(n).padStart(2, '0');
/** Fractional part: turns an index into a repeatable pseudo-random number in [0, 1). */
const frac = (n: number) => n - Math.floor(n);

/**
 * Always-on screen for a spare display: a clock, with the covers played today drifting behind it.
 * Shown over the player while it is fullscreen and nothing is playing.
 */
export function Standby() {
  const [now, setNow] = useState(() => new Date());
  const [covers, setCovers] = useState<string[]>([]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Today's covers, most recent first; refreshed when the date changes.
  const dayKey = now.toDateString();
  useEffect(() => {
    let live = true;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    getPlays(start.getTime(), start.getTime() + 86_400_000).then(
      (plays) => {
        if (!live) return;
        const images = plays.reverse().map((p) => p.image_m).filter((u): u is string => !!u);
        setCovers([...new Set(images)].slice(0, MAX_COVERS));
      },
      () => {},
    );
    return () => { live = false; };
  }, [dayKey]);

  return (
    <div className="standby" role="img" aria-label={`${two(now.getHours())}:${two(now.getMinutes())}`}>
      {covers.map((src, i) => {
        const style = {
          // R2 sequence (plastic-number based): fills the plane evenly instead of lining up on a diagonal.
          left: 2 + frac(0.5 + i * 0.7548776662) * 82 + '%',
          top: 2 + frac(0.5 + i * 0.569840291) * 74 + '%',
          width: `clamp(72px, ${9 + frac(i * 0.27) * 7}vw, 260px)`,
          '--dx': (frac(i * 0.73) - 0.5) * 16 + 'vw',
          '--dy': (frac(i * 0.41) - 0.5) * 14 + 'vh',
          '--spin': (frac(i * 0.57) - 0.5) * 10 + 'deg',
          animationDuration: 38 + frac(i * 0.19) * 34 + 's',
          animationDelay: -frac(i * 0.83) * 40 + 's',
        } as CSSProperties;
        return <img className="standby-cover" key={src} src={src} alt="" style={style} />;
      })}
      <div className="standby-clock">
        <div className="standby-time">{two(now.getHours())}:{two(now.getMinutes())}</div>
        <div className="standby-date">{WEEKDAYS[now.getDay()]}, {MONTHS[now.getMonth()]} {now.getDate()}</div>
      </div>
    </div>
  );
}
