# CLIP//R

CLIP//R is a music guessing game inspired by Heardle. The main mode, **Endless**, lets a player paste any public Spotify playlist and guess its tracks from the shortest possible preview, round after round. The original curated daily game ("CLIP//R daily") lives on as the **legacy** version.

Current release: **v0.92**.

Players begin with 0.5 seconds of audio. A wrong guess or skip unlocks progressively longer clips at 1, 2, 4, 8, and 16 seconds. When the game ends, CLIP//R reveals the track, artist, and album artwork in both the result screen and transmission log, unlocks the full 30-second preview, and links the revealed song to Spotify.

Endless mode runs on **health** rather than a fixed round count. A player starts a session with 8 health. Solving on the first 0.5s clip restores a point (capped at 8), 1s is neutral, and each longer clip costs one more point, down to −4 at the 16s clip; letting a track go completely unsolved is an instant wipeout. At 0 health the session ends and the player can restart for a fresh run with full health.

### Spotify-native audio (v0.90)

As of v0.90, Endless plays **Spotify's own 30-second preview** for each track instead of matching the song to a third party. Because the audio, the accepted answer, and the reveal link all come from the same Spotify track, the song you hear is always exactly the playlist track — the earlier class of wrong-artist mismatches (two different songs sharing a title, e.g. `2025`) is gone by construction. Loading is also far faster: the pool is built directly from the playlist response with no per-track matching pass. Album artwork is still fetched lazily from Deezer when a round is revealed (image only — a wrong artwork match can never change the song you heard). Playlists larger than **1000 tracks are rejected**.

## Endless mode (main)

- Paste a public Spotify playlist link (`open.spotify.com/playlist/…`, an `intl-xx` link, or a `spotify:playlist:…` URI). The playlist becomes both the song pool the game draws from and the complete list of accepted guesses.
- Each round picks a random track from the playlist; after the answer is revealed, **next track** starts a new round. The pool cycles through every track before repeating.
- **Session scoring** tracks your current streak, best streak, number solved, and a solve-by-clip-length distribution. Current streak, solved count, and health reset each session (on load or restart), but the **best streak carries over per playlist** — it's stored in the browser keyed by playlist id, so your record on a given playlist survives restarts, deaths, and reloads. There is no shared daily song and no cross-playlist streak.
- **Switching modes keeps your progress.** The loaded playlist, song pool, health, scoreboard, and the exact round in progress are saved in the browser, so leaving for **Legacy daily** and coming back to Endless resumes where you left off (the snapshot is only replaced when you load a new playlist or restart).
- Recently loaded playlists are remembered in the browser for quick reloading.
- Switch between modes with the **Legacy daily** button in Endless and the **← Endless** button in legacy.

### How the playlist import works

Reading a playlist runs through a small serverless function at `/api/playlist` (deployed alongside the site on Vercel). It is required because every relevant Spotify endpoint omits CORS headers — a browser on the site cannot read them directly — and the public embed page is capped at 100 tracks. The function:

1. Reads Spotify's public playlist **embed page** for the name, cover, an anonymous access token, and the first 100 tracks.
2. For larger playlists, pages the web player's internal `fetchPlaylist` GraphQL with that token to retrieve every track.
3. Returns a normalized track list to the browser.

The function uses **no Spotify login or API key**.

Each track in the response carries Spotify's own preview URL, so the browser plays that audio directly — no third-party matching step. For playlists over 100 tracks, pathfinder enumerates the full list (which doesn't include previews), and the preview for each of those extra tracks is fetched lazily from its track embed (`/api/playlist?preview=<id>`) the first time it is played.

### Known limitations

- **A few tracks may lack a preview.** Playback uses Spotify's own 30-second preview. A small number of tracks have no preview available from Spotify (region or licensing); those are skipped when drawn. Because audio, answer, and reveal link all come from the same Spotify track, a track is never swapped for a different same-titled song — the earlier wrong-artist matching bug does not apply.
- **Album artwork is best-effort.** The reveal screen's cover art is fetched from Deezer by artist + title (Spotify's keyless paths expose no per-track image). If Deezer can't confirm the exact release, the artwork may be slightly off or fall back to the playlist cover. This is cosmetic only — it never affects the song you hear or the accepted answer.
- **The keyless Spotify path is fragile.** For playlists over 100 tracks the `fetchPlaylist` GraphQL call depends on a persisted-query hash baked into Spotify's web player bundle; when Spotify rebuilds the player the hash rotates and the call returns HTTP 412. The function then falls back to the first 100 embed tracks and flags the import as truncated. The anonymous embed token also expires within ~25–50 minutes and is rate-limited. This relies on an undocumented internal API Spotify can change without notice.
- **Only public playlists.** Private or deleted playlists cannot be read by id alone and report as unavailable.

## Legacy daily mode

The original daily game is served at `/legacy`. Everyone gets the same curated track each day and tries to identify it from the shortest possible preview.

Wrong guesses from the correct artist or album receive a yellow hint in the transmission log. Album matches take priority, and featured artists count toward an artist match when Deezer lists them as contributors.

The legacy rotation focuses on hyperpop and adjacent internet-pop scenes. See [CATALOG.md](CATALOG.md) for every accepted search option in legacy mode. That catalog also imports every usable track from the Spotify playlist [is this hyperpop?](https://open.spotify.com/playlist/21BRDwCxzodioo2OnIxIWG); [PLAYLIST_IMPORT.md](PLAYLIST_IMPORT.md) records the import totals and songs that could not be matched to a playable Deezer preview.

### How legacy works

- Track metadata, artwork, and preview audio load from Deezer.
- SoundCloud links take listeners to the corresponding track after the answer is revealed.
- Daily progress, archive progress, and statistics stay in the browser using local storage. Archive results do not change daily win-rate or streak statistics.
- The daily puzzle changes at midnight Eastern time.
- Players can open the archive (the clock icon) to play or revisit any of the previous four days, using the same rules as the daily puzzle.
- Player feedback is collected through the public [CLIP//R feedback form](https://docs.google.com/forms/d/e/1FAIpQLSfywpxig56xgLO4yl6wZSGzIrLlth_e2UFqE8mOt4RLVMcoWQ/viewform).

## Run locally

Endless mode needs the `/api/playlist` function, so run it with the Vercel CLI from the repository root:

```sh
vercel dev
```

Then open the printed local URL (Endless at `/`, legacy at `/legacy`).

The legacy daily game is a plain static page with no backend, so it can also be served on its own:

```sh
python3 -m http.server 4173 --directory dist
```

Then open `http://localhost:4173/legacy.html`. (Endless will load at `http://localhost:4173/` but cannot import playlists without the serverless function.)

## Private queue editor

The queue editor lives at `tools/queue-editor.html`, outside the deployed `dist` directory. It is therefore available only to someone with this private repository checkout and is never published with the game.

Run the repository root locally:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173/tools/queue-editor.html` in Chrome or Edge. Use **Open queue.json** to select `dist/queue.json`; after editing today and the next six days, use **Save queue** to write the file directly. The editor uses Eastern dates, validates every retained entry against the catalog, keeps earlier queue history, and replaces the entire upcoming seven-day window so stale future schedules cannot survive invisibly. Commit and deploy the changed queue when it is ready to go live.

The editor uses the browser's File System Access API. It receives access only to the queue file you explicitly select and does not store a password or GitHub token.

## Project status

CLIP//R is an independent fan prototype. Music availability depends on the preview and metadata endpoints used by the project.
