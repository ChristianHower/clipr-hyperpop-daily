# CLIP//R

CLIP//R is a music guessing game inspired by Heardle. The main mode, **Endless**, lets a player paste any public Spotify playlist and guess its tracks from the shortest possible preview, round after round. The original curated daily game ("CLIP//R daily") lives on as the **legacy** version.

Current release: **v0.85**.

Players begin with 0.5 seconds of audio. A wrong guess or skip unlocks progressively longer clips at 1, 2, 4, 8, and 16 seconds. When the game ends, CLIP//R reveals the track, artist, and album artwork in both the result screen and transmission log, unlocks the full 30-second preview, and links the revealed song to SoundCloud.

Endless mode runs on **health** rather than a fixed round count. A player starts a session with 8 health. Solving on the first 0.5s clip restores a point (capped at 8), 1s is neutral, and each longer clip costs one more point, down to −4 at the 16s clip; letting a track go completely unsolved is an instant wipeout. At 0 health the session ends and the player can restart for a fresh run with full health.

### Streaming playlist load

To cut the wait on large playlists, Endless resolves a **random 100 tracks first**, starts the game immediately, then keeps matching the remaining tracks in the background. Each newly matched track is folded into both the guess list and the round rotation as it arrives (inserted at a random spot in the unplayed remainder, so it can surface within a round or two rather than only after the first 100 are exhausted). Playlists larger than **1000 tracks are rejected** before any matching work begins.

## Endless mode (main)

- Paste a public Spotify playlist link (`open.spotify.com/playlist/…`, an `intl-xx` link, or a `spotify:playlist:…` URI). The playlist becomes both the song pool the game draws from and the complete list of accepted guesses.
- Each round picks a random track from the playlist; after the answer is revealed, **next track** starts a new round. The pool cycles through every track before repeating.
- **Session scoring** tracks your current streak, best streak, number solved, and a solve-by-clip-length distribution. Session stats reset when you load a new playlist or close the tab — there is no shared daily song and no cross-session streak.
- Recently loaded playlists are remembered in the browser for quick reloading.
- Switch between modes with the **Legacy daily** button in Endless and the **← Endless** button in legacy.

### How the playlist import works

Reading a playlist runs through a small serverless function at `/api/playlist` (deployed alongside the site on Vercel). It is required because every relevant Spotify endpoint omits CORS headers — a browser on the site cannot read them directly — and the public embed page is capped at 100 tracks. The function:

1. Reads Spotify's public playlist **embed page** for the name, cover, an anonymous access token, and the first 100 tracks.
2. For larger playlists, pages the web player's internal `fetchPlaylist` GraphQL with that token to retrieve every track.
3. Returns a normalized track list to the browser.

The function uses **no Spotify login or API key**.

The browser then matches each Spotify track to a playable **Deezer** preview (reusing the same audio and metadata engine as the daily game) and builds the round from the matches.

### Known limitations

- **Unmatched tracks are dropped.** A playlist track is only playable if it can be matched to a readable Deezer track with a 30-second preview. Matching is best-effort by artist + title + track length (Spotify's keyless path exposes no ISRC): candidates are scored on title, artist, and duration closeness, and a best match with the wrong artist and a far-off duration is rejected rather than served, so a coincidental same-title song (a cover, a karaoke version, an unrelated pop song) isn't played in place of the real track. When the primary artist-plus-title search comes back weak — common when a non-Latin artist name is paired with a Latin title — the matcher widens with title-only and reordered queries to recover the track. Tracks that still can't be confirmed are excluded from both the song pool and the guess list, and the loader reports how many were skipped. This mirrors the gaps documented in [PLAYLIST_IMPORT.md](PLAYLIST_IMPORT.md) for the curated catalog.
- **Soundtrack / instrumental catalogs match less well.** Scores and OSTs whose tracks live inside large album releases under a non-Latin or romanized composer name, often with generic one-word titles ("Moment", "Burden") and alternate-length album cuts, are harder to confirm by title + artist + duration alone. Some of these are dropped even though the recording exists on Deezer inside an album. Album-based resolution would recover more of them and is a known improvement to be patched — ideally alongside ISRC matching once a non-keyless path is available.
- **The keyless Spotify path is fragile.** The `fetchPlaylist` GraphQL call depends on a persisted-query hash baked into Spotify's web player bundle; when Spotify rebuilds the player the hash rotates and the call returns HTTP 412. The function then falls back to the first 100 embed tracks and flags the import as truncated. The anonymous embed token also expires within ~25–50 minutes and is rate-limited. This relies on an undocumented internal API Spotify can change without notice.
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
