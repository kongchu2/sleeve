# Sleeve

**한국어** | [English](README.en.md)

Spotify 청취 기록을 앨범 커버로 채운 달력으로 보여 주고, 앨범 색으로 물드는 Now Playing 화면에서 싱크 가사를 띄워 줍니다.

![전체 화면 Now Playing: 왼쪽에 앨범 커버, 오른쪽에 싱크 가사, 화면 전체가 커버 색으로 물든 모습](docs/now-playing.jpg)

![Standby: 가장 많이 들은 앨범 커버로 채운 벽 위에 시계가 떠 있는 모습](docs/standby.jpg)

- **Calendar** — 하루하루가 그날 들은 앨범으로 만든 타일입니다. 날짜를 고르면 그날의 앨범, 트랙, 들은 시각을 볼 수 있습니다.
- **Year** — 작은 달력 열두 개를 한 페이지에 담고, 날짜마다 가장 많이 들은 앨범을 보여 줍니다.
- **Recap** — 한 달에 한 장: 가장 많이 들은 앨범, 청취 시간, 가장 많이 들은 시간대.
- **소소한 것들** — 한 달의 흐름을 보여 주는 색 띠, 날짜마다 붙는 "3일 연속", "1년 전 오늘" 메모.
- **Now Playing** — 커버의 대표 색이 화면 전체를 물들이고, 가사가 노래를 따라갑니다. `F`를 누르면 전체 화면이 됩니다.
- **Standby** — 전체 화면으로 둔 채 재생 중인 곡이 없으면, 가장 많이 들은 앨범 커버 벽 위의 시계로 바뀝니다.
- **내 것** — 내 컴퓨터에서, 내 Spotify 앱으로 돌아갑니다. Spotify와 [LRCLIB](https://lrclib.net)(가사를 찾기 위한 곡명과 아티스트명) 말고는 어디에도 데이터를 보내지 않습니다.

## 청취 기록에 대해

Spotify는 최근 50곡까지만 알려 주기 때문에, 기록은 **이 앱을 실행하기 시작한 순간부터**, 그리고 실행 중인 동안에만 쌓입니다.

과거 기록을 채우려면 <https://www.spotify.com/account/privacy/>에서 **Extended streaming history**를 요청한 뒤, 앱의 **Import history** 페이지에서 `Streaming_History_Audio_*.json` 파일을 불러오세요. 재생 기록은 바로 추가되고(중복으로 들어가지 않습니다), 커버 이미지는 그 뒤에 백그라운드에서 찾아오는데, 기록이 많으면 몇 시간이 걸립니다.

## 준비물

- Spotify 계정. 현재 Spotify는 개발자 앱의 소유자가 **Premium**이어야 한다고 요구합니다.
- Docker 또는 Node.js 24 이상.

## 1. Spotify 앱 만들기

1. <https://developer.spotify.com/dashboard>에서 앱을 만듭니다.
2. **Web API**를 체크합니다.
3. Redirect URI로 `http://127.0.0.1:8787/auth/callback`을 추가합니다(`localhost`가 아니라 반드시 `127.0.0.1`이어야 합니다).
4. 앱 설정에서 **Client ID**와 **Client secret**을 복사합니다.

## 2. 설정

```sh
git clone https://github.com/kongchu2/sleeve.git
cd sleeve
cp .env.example .env      # 그다음 .env에 Client ID와 secret을 넣습니다
```

## 3. 실행

### Docker로

```sh
docker compose up -d --build
```

<http://127.0.0.1:8787>을 열고 **Connect Spotify**를 누릅니다. 기록은 `listening-data` Docker 볼륨에 저장되며, 재시작하거나 다시 빌드해도 유지됩니다.

### Node로

```sh
npm ci
npm run build
npm start
```

<http://127.0.0.1:8787>을 엽니다. 데이터베이스는 `data/listening.db`입니다.

계속 켜 두세요. 페이지가 열려 있는 동안에는 곡이 끝날 때마다, 그렇지 않을 때는 적어도 15분마다 재생 기록을 수집합니다.

## 개발

```sh
npm install
npm run dev               # http://127.0.0.1:5180, API는 :8787
npm test                  # node:test, 인메모리 데이터베이스 사용
```

- `server/` — Hono API, Spotify 클라이언트, 수집기, SQLite(`node:sqlite`).
- `src/` — React 앱. `src/color.ts`가 브라우저에서 커버의 포인트 색을 뽑아냅니다.

## 서버에서 실행하기

서버는 `127.0.0.1`에서만 요청을 받습니다. 다른 기기에서 접속하려면 **HTTPS와 접근 제어**를 제공하는 것(Tailscale 같은 사설 네트워크, 또는 인증이 붙은 리버스 프록시) 뒤에 두세요. API에 접근할 수 있는 사람은 누구나 청취 기록을 읽고, 재생 기록을 가져와 넣고, 로그아웃시킬 수 있습니다.

- Spotify는 루프백이 아닌 Redirect URI에 HTTPS를 요구합니다. Spotify 대시보드에 `https://your-host/auth/callback`을 등록하고 `SPOTIFY_REDIRECT_URI`를 설정하거나, 내 컴퓨터에서 한 번 로그인한 뒤 `data/listening.db`를 서버로 복사하세요.
- 서버는 `localhost`, IP 주소, `APP_URL`·`SPOTIFY_REDIRECT_URI`의 호스트로 온 요청에만 답합니다. 다른 웹사이트가 DNS rebinding으로 접근하는 것을 막기 위해서입니다. 다른 이름(예: Tailscale MagicDNS 이름)으로 접속한다면 그 이름을 `ALLOWED_HOSTS`에 추가하세요.
- systemd 유닛 예시는 `deploy/systemd/`에 있습니다.

### 선택 사항: 기록을 git 저장소에 보관하기

`server/worker.ts`는 독립 실행형 수집기로, 모든 재생 기록을 별도의 git 저장소에 JSON Lines(`plays/YYYY-MM.jsonl`)로 내보내고, 최대 15분에 한 번 push하며, 시작할 때 그 저장소에서 데이터베이스를 복원합니다. 사용하려면 웹 서버를 `COLLECT=0`으로 실행하고, 그 옆에서 `npm run worker`를 실행하고, `DATA_REPO_DIR`을 push할 수 있는 보관용 저장소의 클론 경로로 설정하세요.

## 선택 사항: Spotify 자체 가사 (사이드카)

LRCLIB에 모든 곡이 있는 것은 아닙니다. `lyrics-sidecar/`는 Spotify 클라이언트로 로그인해([librespot](https://github.com/librespot-org/librespot) 사용) Spotify 자체 가사(대개 줄 단위로 싱크됨)를 localhost에서 제공하는 작은 Rust 프로그램입니다. 서버는 이 가사를 먼저 쓰고, 없으면 LRCLIB으로 넘어갑니다. Rust와 한 번의 로그인이 필요합니다.

```sh
cd lyrics-sidecar
cargo build --release
./target/release/lyrics-sidecar --login     # 브라우저가 열립니다. 한 번만 승인하면 됩니다
```

그다음 `.env`에 `SPOTIFY_LYRICS_URL=http://127.0.0.1:8899`를 설정하고, 서버와 함께 바이너리를 실행하세요(systemd 유닛 예시는 `deploy/systemd/`에 있습니다).

이 기능은 실제 클라이언트 로그인을 통해 문서화되지 않은 Spotify 엔드포인트를 사용합니다. 따라서 Spotify 약관상 회색 지대에 있고, 재사용 가능한 계정 인증 정보를 디스크(`data/spotify/credentials.json`)에 저장하며, Spotify가 무언가를 바꾸면 동작하지 않을 수 있습니다. `SPOTIFY_LYRICS_URL`을 설정하지 않으면 꺼져 있습니다.

## 설정 항목

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | — | Spotify 앱의 인증 정보(필수) |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:$PORT/auth/callback` | 대시보드에 등록한 Redirect URI와 일치해야 합니다 |
| `PORT` | `8787` | 서버가 사용하는 포트 |
| `HOST` | `127.0.0.1` | 서버가 바인딩하는 주소 |
| `ALLOWED_HOSTS` | — | 서버가 추가로 받아들일 호스트 이름(쉼표로 구분, [서버에서 실행하기](#서버에서-실행하기) 참고) |
| `DB_PATH` | `data/listening.db` | SQLite 데이터베이스 파일 |
| `COLLECT` | 켜짐 | `0`으로 설정하면 웹 서버가 수집하지 않습니다(worker가 수집할 때) |
| `DATA_REPO_DIR` | — | worker가 사용하는 보관용 저장소 클론 |
| `ARCHIVE_PUSH_MINUTES` | `15` | 보관용 저장소에 push하는 최소 간격(분) |

## 라이선스

[MIT](LICENSE)
