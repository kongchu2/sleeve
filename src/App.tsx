import { useCallback, useEffect, useState } from 'react';
import { getNow, getStatus, type Now, type Status } from './api.ts';
import { Calendar } from './Calendar.tsx';
import { NowPlaying } from './NowPlaying.tsx';

const viewFromHash = () => (location.hash === '#/now' ? 'now' : 'calendar');

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState(viewFromHash);
  const [now, setNow] = useState<Now | null>(null);

  useEffect(() => {
    getStatus().then(setStatus, () => setFailed(true));
    const onHash = () => setView(viewFromHash());
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

  return view === 'now' ? <NowPlaying now={now} refresh={refreshNow} /> : <Calendar now={now} />;
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
