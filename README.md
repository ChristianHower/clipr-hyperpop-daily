# CLIP//R

CLIP//R is a daily hyperpop music guessing game inspired by Heardle. Everyone gets the same curated track each day and tries to identify it from the shortest possible preview.

Current release: **v0.62**.

Players begin with 0.5 seconds of audio. A wrong guess or skip unlocks progressively longer clips at 1, 2, 4, 8, and 16 seconds. When the game ends, CLIP//R reveals the track, artist, and album artwork in both the result screen and transmission log, unlocks the full 30-second preview, and links the revealed song to SoundCloud.

Wrong guesses from the correct artist or album receive a yellow hint in the transmission log. Album matches take priority, and featured artists count toward an artist match when Deezer lists them as contributors.

The rotation focuses on hyperpop and adjacent internet-pop scenes. See [CATALOG.md](CATALOG.md) for every accepted search option. The current catalog also imports every usable track from the Spotify playlist [is this hyperpop?](https://open.spotify.com/playlist/21BRDwCxzodioo2OnIxIWG); [PLAYLIST_IMPORT.md](PLAYLIST_IMPORT.md) records the import totals and songs that could not be matched to a playable Deezer preview.

## How it works

- Track metadata, artwork, and preview audio load from Deezer.
- SoundCloud links take listeners to the corresponding track after the answer is revealed.
- Daily progress, archive progress, and statistics stay in the browser using local storage. Archive results do not change daily win-rate or streak statistics.
- The daily puzzle changes at midnight Eastern time.
- Players can open the archive (the clock icon) to play or revisit any of the previous four days, using the same rules as the daily puzzle.
- Player feedback is collected through the public [CLIP//R feedback form](https://docs.google.com/forms/d/e/1FAIpQLSfywpxig56xgLO4yl6wZSGzIrLlth_e2UFqE8mOt4RLVMcoWQ/viewform).
- The game is a static, single-page site with no build step.

## Run locally

```sh
python3 -m http.server 4173 --directory dist
```

Then open `http://localhost:4173`.

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
