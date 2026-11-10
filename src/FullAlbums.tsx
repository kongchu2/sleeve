import { useEffect, useState } from 'react';
import { getFullAlbums, type FullAlbum } from './api.ts';
import { BackLink, MONTHS } from './shared.tsx';

const two = (n: number) => String(n).padStart(2, '0');

/** The shelf: every album played start to finish, most recent first. */
export function FullAlbums() {
  const [albums, setAlbums] = useState<FullAlbum[] | null>(null);

  useEffect(() => {
    getFullAlbums().then(setAlbums, () => setAlbums([]));
  }, []);

  const listens = albums?.reduce((a, b) => a + b.times.length, 0) ?? 0;

  return (
    <div className="page">
      <div className="wrap">
        <header className="cal-header">
          <div className="cal-title">
            <BackLink />
            <h1 className="page-title">Full albums</h1>
            <div className="cal-summary">
              {albums === null
                ? ' '
                : albums.length
                  ? `${albums.length} album${albums.length === 1 ? '' : 's'} played start to finish, ${listens} time${listens === 1 ? '' : 's'} in total`
                  : 'Play every track of an album in one go and it lands here.'}
            </div>
          </div>
        </header>

        <main className="shelf">
          {albums?.map((a) => {
            const last = new Date(a.times[a.times.length - 1]);
            return (
              <a className="shelf-item" key={a.id} href={`#/day/${last.getFullYear()}-${two(last.getMonth() + 1)}-${two(last.getDate())}`}>
                <span className="shelf-cover">{a.image && <img src={a.image} alt="" loading="lazy" />}</span>
                <span className="shelf-name">{a.name}</span>
                <span className="shelf-sub">{a.artists}</span>
                <span className="shelf-meta">
                  {MONTHS[last.getMonth()].slice(0, 3)} {last.getDate()}, {last.getFullYear()}
                  {a.times.length > 1 && ` · ×${a.times.length}`}
                </span>
              </a>
            );
          })}
        </main>
      </div>
    </div>
  );
}
