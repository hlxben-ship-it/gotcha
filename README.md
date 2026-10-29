# Gotcha

Paste a URL, see every video on the page, download the ones you pick. Thin local UI over [yt-dlp](https://github.com/yt-dlp/yt-dlp).

## Run

```powershell
.\start_gotcha.ps1   # → http://localhost:3006
```

Needs Node 20+, `yt-dlp` and `ffmpeg` on PATH (`winget install yt-dlp.yt-dlp` pulls both). No npm dependencies.

## How it works

- `POST /api/analyse` — `yt-dlp -J --flat-playlist`; playlists become one card per entry. Unknown sites fall back to scraping direct media links (`.mp4/.webm/.m3u8/…`) from the HTML.
- `POST /api/download` — queues jobs, 2 in parallel; quality = best / ≤1080 / ≤720 / ≤480 / mp3.
- `GET /api/jobs` — polled by the UI every second for progress.
- Files land in `downloads/`.

## URL rewrites

Some sites serve share URLs yt-dlp has no extractor for. Map them onto a supported shape in `rewrites.local.json` (gitignored, see `rewrites.example.json`).
