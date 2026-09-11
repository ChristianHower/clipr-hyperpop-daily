# CLIP//R

CLIP//R is a daily hyperpop music guessing game inspired by Heardle. Everyone gets the same curated track each day and tries to identify it from the shortest possible preview.

Players begin with one second of audio. A wrong guess or skip unlocks progressively longer clips at 2, 4, 7, 11, and 16 seconds. When the game ends, CLIP//R reveals the track, artist, and album artwork, unlocks the full 30-second preview, and links to the song on SoundCloud.

The rotation focuses on artists from hyperpop and adjacent internet-pop scenes, including glaive, Ninajirachi, Tiffany Day, Frost Children, Porter Robinson, tsubi club, Jane Remover, underscores, brakence, ericdoa, 8485, and Alice Longyu Gao.

## How it works

- Track metadata, artwork, and preview audio load from Deezer.
- SoundCloud links take listeners to the corresponding track after the answer is revealed.
- Daily progress and statistics stay in the browser using local storage.
- The game is a static, single-page site with no build step.

## Run locally

```sh
python3 -m http.server 4173 --directory dist
```

Then open `http://localhost:4173`.

## Project status

CLIP//R is an independent fan prototype. Music availability depends on the preview and metadata endpoints used by the project.
