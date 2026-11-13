//! Fetches Spotify's own lyrics for one track, for the Sleeve web app.
//!
//! The public Web API has no lyrics; Spotify's clients read an internal
//! `color-lyrics` endpoint that a developer token cannot reach. This process
//! signs in as a Spotify client through librespot (OAuth, once) and exposes a
//! tiny localhost endpoint the Node server calls, falling back to LRCLIB when
//! Spotify has no lyrics.
//!
//! Usage:
//!   lyrics-sidecar --login     # one-time interactive OAuth; saves credentials
//!   lyrics-sidecar             # serve GET /lyrics?id=<base62> on LYRICS_BIND
//!
//! Env: LYRICS_CACHE_DIR (credentials dir, default data/spotify),
//!      LYRICS_BIND (default 127.0.0.1:8899).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use librespot_core::{
    authentication::Credentials, cache::Cache, error::ErrorKind, Session, SessionConfig, SpotifyId,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

// Spotify's desktop ("keymaster") client id, the one librespot authenticates
// as; its OAuth app registers this loopback redirect.
const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
const REDIRECT_URI: &str = "http://127.0.0.1:8898/login";

fn cache_dir() -> PathBuf {
    std::env::var_os("LYRICS_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/spotify"))
}

fn open_cache() -> Result<Cache> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir).ok();
    Cache::new(Some(dir.as_path()), None, None, None).context("open credentials cache")
}

/// One-time OAuth: authorise in a browser, then save reusable credentials.
async fn login() -> Result<()> {
    let cache = open_cache()?;
    let client =
        librespot_oauth::OAuthClientBuilder::new(CLIENT_ID, REDIRECT_URI, vec!["streaming"])
            .build()
            .map_err(|e| anyhow!("oauth setup: {e}"))?;
    let token = client
        .get_access_token_async()
        .await
        .map_err(|e| anyhow!("oauth: {e}"))?;
    let session = Session::new(SessionConfig::default(), Some(cache));
    session
        .connect(Credentials::with_access_token(token.access_token), true)
        .await
        .map_err(|e| anyhow!("connect: {e}"))?;
    println!("Logged in as {}. Credentials saved.", session.username());
    Ok(())
}

/// Connects using the saved credentials (no browser).
async fn connect_session() -> Result<Session> {
    let cache = open_cache()?;
    let creds = cache
        .credentials()
        .ok_or_else(|| anyhow!("no saved credentials; run `lyrics-sidecar --login` first"))?;
    let session = Session::new(SessionConfig::default(), Some(cache));
    session
        .connect(creds, false)
        .await
        .map_err(|e| anyhow!("connect: {e}"))?;
    Ok(session)
}

struct State {
    session: Mutex<Session>,
}

/// Returns the raw color-lyrics JSON for a track, `None` when Spotify has none.
/// Reconnects once if the session has dropped.
async fn lyrics_json(state: &State, id: &str) -> Result<Option<Vec<u8>>> {
    let track = SpotifyId::from_base62(id).map_err(|_| anyhow!("invalid track id"))?;
    let mut last = anyhow!("unknown error");
    for attempt in 0..2 {
        let session = state.session.lock().await.clone();
        match session.spclient().get_lyrics(&track).await {
            Ok(bytes) => return Ok(Some(bytes.to_vec())),
            Err(e) if e.kind == ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                last = anyhow!("get_lyrics: {e}");
                if attempt == 0 {
                    match connect_session().await {
                        Ok(s) => *state.session.lock().await = s,
                        Err(ce) => return Err(ce.context("reconnect")),
                    }
                }
            }
        }
    }
    Err(last)
}

async fn respond(sock: &mut TcpStream, status: u16, ctype: &str, body: &[u8]) -> Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Service Unavailable",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(body).await?;
    sock.flush().await?;
    Ok(())
}

async fn handle(state: &State, sock: &mut TcpStream) -> Result<()> {
    let mut buf = [0u8; 2048];
    let n = sock.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    if !target.starts_with("/lyrics") {
        return respond(sock, 400, "text/plain", b"bad request").await;
    }
    let id = target
        .split_once("id=")
        .map(|(_, rest)| rest.split('&').next().unwrap_or(""))
        .unwrap_or("");
    if id.is_empty() {
        return respond(sock, 400, "text/plain", b"id required").await;
    }
    match lyrics_json(state, id).await {
        Ok(Some(bytes)) => respond(sock, 200, "application/json", &bytes).await,
        Ok(None) => respond(sock, 404, "text/plain", b"no lyrics").await,
        Err(e) => {
            eprintln!("[lyrics] {e:#}");
            respond(sock, 503, "text/plain", b"unavailable").await
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--login") {
        return login().await;
    }
    let addr = std::env::var("LYRICS_BIND").unwrap_or_else(|_| "127.0.0.1:8899".into());
    let session = connect_session().await?;
    println!("connected as {}; serving lyrics on {addr}", session.username());
    let state = Arc::new(State {
        session: Mutex::new(session),
    });
    let listener = TcpListener::bind(&addr).await.context("bind")?;
    loop {
        let (mut sock, _) = listener.accept().await?;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(&state, &mut sock).await {
                eprintln!("[lyrics] connection: {e:#}");
            }
        });
    }
}
