import { useCallback, useEffect, useState } from 'react';
import { getNow, getStatus, type Now, type Status } from './api.ts';
import { Calendar } from './Calendar.tsx';
import { FullAlbums } from './FullAlbums.tsx';
import { ImportHistory } from './ImportHistory.tsx';
import { NowPlaying } from './NowPlaying.tsx';
import { YearView } from './YearView.tsx';

type Route = { view: 'calendar' | 'now' | 'year' | 'albums' | 'import'; date?: { y: number; m: number; d: number } };

/** `#/now`, `#/year`, `#/albums`, `#/import`, or `#/day/2026-11-10` to open the calendar on a day. */
function routeFromHash(): Route {
  const hash = location.hash;
  if (hash === '#/now') return { view: 'now' };
  if (hash === '#/year') return { view: 'year' };
  if (hash === '#/albums') return { view: 'albums' };
  if (hash === '#/import') return { view: 'import' };
  const day = hash.match(/^#\/day\/(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return { view: 'calendar', date: { y: Number(day[1]), m: Number(day[2]) - 1, d: Number(day[3]) } };
  return { view: 'calendar' };
}

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [route, setRoute] = useState(routeFromHash);
  const view = route.view;
  const [now, setNow] = useState<Now | null>(null);

  useEffect(() => {
    getStatus().then(setStatus, () => setFailed(true));
    const onHash = () => setRoute(routeFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const refreshNow = useCallback(async () => {
    try {
      setNow(await getNow());
    } catch {
      /* keep the last known state on a transient failure */
    }
  }, []);

  const authed = status?.authed ?? false;
  useEffect(() => {
    if (!authed) return;
    void refreshNow();
    const id = setInterval(() => { if (!document.hidden) void refreshNow(); }, view === 'now' ? 3000 : 8000);
    return () => clearInterval(id);
  }, [authed, view, refreshNow]);

  if (failed) return <Gate title="Can't reach the server" body="Make sure it is running with npm run dev." />;
  if (!status) return <div className="gate" />;
  if (!status.configured)
    return (
      <Gate
        title="Spotify app setup needed"
        body="Copy .env.example to .env, fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET, then restart the server."
      />
    );
  if (!status.authed)
    return (
      <Gate title="Turn your listening into a calendar" body="Connect your Spotify account and every day from now on fills up with the albums you played.">
        <a className="gate-cta" href="/auth/login">Connect Spotify</a>
      </Gate>
    );

  if (view === 'now') return <NowPlaying now={now} refresh={refreshNow} />;
  if (view === 'year') return <YearView />;
  if (view === 'albums') return <FullAlbums />;
  if (view === 'import') return <ImportHistory />;
  // Keyed by the requested day so following a link from another view re-opens the calendar there.
  return <Calendar now={now} initial={route.date} key={route.date ? `${route.date.y}-${route.date.m}-${route.date.d}` : 'today'} />;
}

function Gate({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="gate">
      <div className="mono-label">LISTENING LOG</div>
      <h1>{title}</h1>
      <p>{body}</p>
      {children}
    </div>
  );
}
