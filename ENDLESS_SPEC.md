# CLIP//R // ENDLESS — spec

Status: **planned** (not yet built). This document is the reference for the move from a
curated daily game to a player-supplied, unlimited mode.

## Summary

Promote an **unlimited music guessing game** to the new main page. The player pastes a
**Spotify playlist link**, and that playlist becomes both:

- the **answer pool** — the songs the game pulls from, and
- the **guess autocomplete list** — the only accepted guesses.

The current curated daily game ("CLIP//R daily") becomes the **legacy** version, still fully
playable at `/legacy`, unchanged in behavior.

## Decisions (locked)

| # | Decision | Choice |
| - | -------- | ------ |
| A | How to read the Spotify playlist | **A1 keyless** (public embed page + web-player GraphQL), via a **Vercel serverless proxy**. No Spotify login or API key. |
| B | Tracks that don't resolve to a playable preview | **Drop them** from play, count them, and document the limitation in the README. |
| C | Routing for legacy, no new domain | `/legacy` served as a second static file on the **same domain**; proxy is an `/api` function on the same domain. |
| 2 | Spotify→Deezer match confidence | Ship **best-effort** matching (no ISRC); obvious mismatches are a logged limitation. |
| 3 | Endless scoring | **Session scoring only** for now (current run, best streak this session, guess distribution). No shared daily song. |
| 4 | Legacy entry point | **Button** in the Endless UI to legacy, **and** a button in legacy back to the main page. |

## Why a serverless proxy is required

A1 ("keyless") cannot run from the browser on a static site:

- Every relevant Spotify endpoint (`open.spotify.com/embed`, `api-partner.spotify.com`,
  `oembed`, `api.spotify.com`) omits CORS headers, so the player's browser is blocked from
  reading the response. The known-working keyless technique is **server-side only** (curl/Node).
- The truly public embed page is **hard-capped at 100 tracks** with no paging. Beating the cap
  requires the web player's internal GraphQL (`fetchPlaylist` on `api-partner.spotify.com`),
  which also has no CORS headers.

Vercel serverless functions run on the **same domain for free**, so this needs no new domain
(decision C holds) and no Spotify credentials (A1 stays keyless — the call is just relayed
through our own origin).

## Fragility of the keyless path (documented, handled)

- `fetchPlaylist` is gated by a **`sha256Hash` persisted-query id** baked into Spotify's web
  player bundle. When Spotify rebuilds the player the hash rotates and the call returns
  **HTTP 412 "Invalid query hash."** We ship the hash as a constant and treat 412 as
  "fall back to the first 100 embed tracks" rather than a fatal error.
- The embed's **anonymous token expires in ~25–50 min** and is rate-limited (≈120 back-to-back
  calls observed OK). We fetch a fresh token per import.
- This is an **undocumented internal API** Spotify can change or remove at any time, and its
  User Guidelines discourage scraping. Accepted trade-off, documented in the README.
- No ISRC is available on this path, so Spotify→Deezer matching is by title+artist only.

## Routing & files

| Path | Purpose |
| ---- | ------- |
| `dist/index.html` | **New Endless mode** (new main). |
| `dist/legacy.html` | The **current daily game**, moved verbatim (archive, queue, same rules). |
| `dist/catalog.js`, `dist/queue.json` | Legacy only. |
| `tools/queue-editor.html` | Legacy only (unchanged). |
| `api/playlist.js` | New Vercel serverless function (the keyless Spotify proxy). |
| `vercel.json` | Add rewrite so `/legacy` serves `dist/legacy.html`. |

Cross-links: Endless topbar has a **"Legacy daily"** button → `/legacy`; legacy topbar has a
**"← Endless"** button back to `/`.

## Playlist pipeline

1. **Input.** Player pastes a Spotify playlist URL. Accept `open.spotify.com/playlist/<id>`,
   `open.spotify.com/intl-xx/playlist/<id>`, and `spotify:playlist:<id>`; strip the query
   string. Reject non-playlist URLs with a clear message. `spotify.link` short links: stretch
   goal.
2. **`/api/playlist?id=<id>`** (server-side):
   - Fetch the embed page, parse `__NEXT_DATA__` → `name`, `cover`, anonymous token, first 100
     tracks.
   - If `totalCount > 100`, page `fetchPlaylist` on `api-partner.spotify.com` with the token
     until `totalCount` is reached (offset/limit, limit 500).
   - On **412** or any pathfinder failure → fall back to the 100 embed tracks, set
     `truncated: true`.
   - Return `{ name, cover, total, truncated, tracks: [{ title, artists[], durationMs,
     isPlayable }] }`. Prefer the pathfinder artist array over the comma-split embed string.
3. **Browser: resolve Spotify track → Deezer** using the existing `deezerJsonp` engine. For
   each track, search Deezer by artist+title and pick the best `readable` match with a
   `preview`. Reuse the existing album/artist near-miss metadata plumbing.
   - **(B)** Tracks with no playable Deezer match are dropped from the answer pool and guess
     list and counted. Surface a summary like "132 of 150 tracks loaded; 18 unavailable".
   - Show progress while resolving; cache resolutions in-memory.
4. **Build session.** The resolved list is the guess autocomplete **and** the answer pool.

## Gameplay (Endless)

- Reuse the existing clip engine unchanged: clip steps `0.5, 1, 2, 4, 8, 16`, 6 attempts,
  artist/album yellow near-miss hints, 30s reveal, SoundCloud + Deezer links. **Only the song
  source changes.**
- **Endless loop.** Pick a random track from the resolved pool each round; no repeats until the
  pool is exhausted, then reshuffle. A **"Next track"** button after the reveal starts a new
  round.
- **(3) Session scoring.** Track current run and best streak this session plus a guess
  distribution, kept in `localStorage` not keyed to any date. No shared "everyone gets the same
  song today," no daily streak.
- Remember recent playlists in `localStorage` for quick reload.

## Legacy mode

- Byte-for-byte the current experience at `/legacy`: daily puzzle, 4-day archive, queue,
  private queue editor, local daily stats/streak. Only additions: a header note that it is the
  legacy daily version and the **"← Endless"** button back to `/`.

## README / known limitations (to add)

Document: the serverless proxy and why it exists; that unresolved/unplayable tracks are dropped
(best-effort title+artist Deezer match, no ISRC, echoing `PLAYLIST_IMPORT.md`); the Spotify
internal-API fragility (412 hash rotation → 100-track fallback) and token/rate limits; and the
scraping trade-off.

## Out of scope (for now)

- Shareable Endless results.
- `spotify.link` short-link resolution.
- Deezer/Apple Music playlist input.
- ISRC-based matching.
