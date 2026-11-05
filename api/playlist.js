// CLIP//R Endless — keyless Spotify playlist proxy.
//
// Runs server-side on Vercel to dodge two browser-side blockers:
//   1. Every Spotify endpoint used here omits CORS headers, so a browser cannot read them.
//   2. The public embed page is hard-capped at 100 tracks with no paging.
//
// Strategy: read the public embed page for the playlist name, cover, an anonymous access
// token, and the first 100 tracks. If the playlist is larger, page the web player's internal
// `fetchPlaylist` GraphQL with that token until complete. If that internal call fails (the
// persisted-query hash rotates and returns 412, the token is refused, throttling, etc.), fall
// back to the 100 embed tracks and report `truncated: true`.
//
// No Spotify login or API key is used. This depends on an undocumented internal API Spotify
// can change without notice; see ENDLESS_SPEC.md and the README known-limitations section.

// Persisted-query id for `fetchPlaylist` in Spotify's web player bundle. Rotates whenever
// Spotify rebuilds that query; a 412 "Invalid query hash" triggers the 100-track fallback.
const FETCH_PLAYLIST_HASH = "8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a";
const EMBED_PAGE_CAP = 100;
const PATHFINDER_PAGE = 500;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

// --- Security / abuse-resistance knobs -------------------------------------------------------
// This endpoint fans one inbound request out to several outbound Spotify fetches, so it must be
// treated as an amplification surface: cap how hard a single caller can push it and how far a
// single request can amplify.
//
// Hard ceiling on tracks enumerated per request. README states playlists over 1000 tracks are
// rejected, so there is no legitimate reason to page beyond that; this caps outbound pathfinder
// calls at ~2 pages instead of the previous 40. A caller cannot turn one request into dozens of
// outbound calls.
const MAX_TRACKS = 1000;
// Per-outbound-fetch timeout. Without this a single slow/hung Spotify connection pins the
// function for its whole max duration, which is itself a cheap denial-of-service.
const FETCH_TIMEOUT_MS = 8000;

// Allowed origins for cross-site (browser) use of this API. Same-origin requests from the
// deployed site send no Origin (or the site's own), so they are always allowed; only other
// sites get rejected, which stops the function being used as a free open Spotify proxy. Set the
// ALLOWED_ORIGINS env var (comma-separated) in Vercel to match your production domain(s).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// In-memory sliding-window rate limiter. This is per warm serverless instance (not a global
// cross-region limit), so it is a first line of defence, not a hard quota — pair it with
// Vercel's platform-level DDoS protection / WAF and a spend cap for real guarantees. It still
// blunts the common case: a single IP hammering one instance.
const RATE_LIMIT_MAX = 30;            // requests
const RATE_LIMIT_WINDOW_MS = 60_000;  // per minute, per IP
const rateBuckets = new Map();        // ip -> number[] of request timestamps (ms)

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "unknown";
}

// Returns true if this IP is now over the limit (and should be rejected).
function isRateLimited(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(ip) || []).filter((t) => t > cutoff);
  hits.push(now);
  rateBuckets.set(ip, hits);
  // Opportunistic cleanup so the map can't grow without bound on a long-lived instance.
  if (rateBuckets.size > 5000) {
    for (const [key, times] of rateBuckets) {
      if (!times.some((t) => t > cutoff)) rateBuckets.delete(key);
    }
  }
  return hits.length > RATE_LIMIT_MAX;
}

// fetch() with a hard timeout so one slow upstream connection can't pin the function.
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Resolve the CORS origin to echo back, or null to deny cross-site reads. No env configured =>
// same-origin-only (browser omits/sets its own Origin for same-origin, so the site keeps working
// while other sites are refused). "*" in ALLOWED_ORIGINS opts back into a fully open proxy.
function resolveCorsOrigin(origin) {
  if (!origin) return null;                       // same-origin / non-browser: no CORS header needed
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

function applyBaseHeaders(res, corsOrigin) {
  if (corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

// Accept the forms Spotify shares; return the 22-char base-62 id or null.
function parsePlaylistId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const value = raw.trim();
  const direct = value.match(/^[0-9A-Za-z]{22}$/);
  if (direct) return value;
  const uri = value.match(/spotify:playlist:([0-9A-Za-z]{22})/);
  if (uri) return uri[1];
  const url = value.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([0-9A-Za-z]{22})/);
  if (url) return url[1];
  // A non-playlist Spotify URL (track/album/artist/user) should be rejected clearly.
  if (/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|artist|user|episode|show)\//.test(value)) {
    return { error: "not-a-playlist" };
  }
  return null;
}

function joinArtists(list) {
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

async function fetchEmbed(id) {
  const res = await fetchWithTimeout(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" }
  });
  if (!res.ok) throw new Error(`embed page HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("embed page has no __NEXT_DATA__");
  const data = JSON.parse(match[1]);
  const pageProps = data?.props?.pageProps;
  // An unknown id answers HTTP 200 but with status 404 and no state/token.
  if (pageProps?.status && pageProps.status >= 400 && !pageProps?.state) {
    return { notFound: true };
  }
  const entity = pageProps?.state?.data?.entity;
  const session = pageProps?.state?.settings?.session;
  if (!entity || !session?.accessToken) return { notFound: true };
  const tracks = (entity.trackList || []).map((t) => ({
    id: idFromUri(t.uri),
    title: t.title || "",
    // The embed only gives a comma-joined artist string; pathfinder has the real list.
    artists: (t.subtitle || "").split(", ").map((s) => s.trim()).filter(Boolean),
    durationMs: Number(t.duration) || null,
    // Spotify's own 30-second preview for this exact track — the source of truth for audio.
    preview: (t.audioPreview && t.audioPreview.url) || null,
    isPlayable: t.isPlayable !== false
  }));
  return {
    name: entity.name || "Spotify playlist",
    cover: entity.coverArt?.sources?.[0]?.url || entity.coverArt?.sources?.slice(-1)?.[0]?.url || null,
    token: session.accessToken,
    tracks
  };
}

// Extract the 22-char base-62 track id from a "spotify:track:<id>" uri.
function idFromUri(uri) {
  if (typeof uri !== "string") return null;
  const m = uri.match(/spotify:track:([0-9A-Za-z]{22})/);
  return m ? m[1] : null;
}

async function fetchAllViaPathfinder(id, token) {
  const out = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const body = {
      variables: { uri: `spotify:playlist:${id}`, offset, limit: PATHFINDER_PAGE, enableWatchFeedEntrypoint: false },
      operationName: "fetchPlaylist",
      extensions: { persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST_HASH } }
    };
    const res = await fetchWithTimeout("https://api-partner.spotify.com/pathfinder/v2/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": BROWSER_UA },
      body: JSON.stringify(body)
    });
    if (res.status === 412) throw new Error("hash-rotated"); // triggers 100-track fallback
    if (!res.ok) throw new Error(`pathfinder HTTP ${res.status}`);
    const json = await res.json();
    const playlist = json?.data?.playlistV2;
    if (!playlist || playlist.__typename === "NotFound" || playlist.__typename === "GenericError") {
      throw new Error("pathfinder returned no playlist");
    }
    const content = playlist.content || {};
    total = Number(content.totalCount) || out.length;
    const items = content.items || [];
    if (!items.length) break;
    for (const item of items) {
      const wrapper = item?.itemV2;
      const kind = wrapper?.__typename;
      if (kind === "TrackResponseWrapper" && wrapper.data?.__typename === "Track") {
        const d = wrapper.data;
        out.push({
          id: idFromUri(d.uri) || null,
          title: d.name || "",
          artists: joinArtists(d.artists?.items?.map((a) => a?.profile?.name)),
          album: d.albumOfTrack?.name || null,
          durationMs: d.trackDuration?.totalMilliseconds || null,
          // Pathfinder's Track doesn't carry a preview; it's fetched lazily per track from the
          // track embed (see the ?preview= branch of the handler) only when the track is played.
          preview: null,
          isPlayable: (d.playability?.reason || "PLAYABLE") === "PLAYABLE"
        });
      }
      // Skip LocalTrack, podcast episodes, and any wrapper we don't recognise.
    }
    offset += items.length;
    if (offset >= total) break;
    if (out.length >= MAX_TRACKS) break; // amplification cap: stop paging a single request early
  }
  return out;
}

// Fetch a single track's preview URL from its embed page (keyless). Used to lazily resolve
// previews for tracks beyond the first 100 in a large playlist, which pathfinder doesn't carry.
async function fetchTrackPreview(trackId) {
  const res = await fetchWithTimeout(`https://open.spotify.com/embed/track/${trackId}`, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en" }
  });
  if (!res.ok) throw new Error(`track embed HTTP ${res.status}`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("track embed has no __NEXT_DATA__");
  const data = JSON.parse(match[1]);
  const entity = data?.props?.pageProps?.state?.data?.entity;
  return (entity?.audioPreview && entity.audioPreview.url) || null;
}

module.exports = async function handler(req, res) {
  const corsOrigin = resolveCorsOrigin(req.headers.origin);
  applyBaseHeaders(res, corsOrigin);

  // CORS preflight: answer and stop. (Only reached for cross-site requests.)
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // Read-only endpoint: only GET is meaningful. Reject everything else up front.
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  // A cross-site request whose Origin is not on the allow-list is refused — the function is not
  // an open proxy. Same-origin requests from the site send no Origin and are unaffected.
  if (req.headers.origin && !corsOrigin) {
    res.status(403).json({ error: "Origin not allowed." });
    return;
  }

  // Per-IP rate limiting. First line of defence against a single caller hammering the endpoint;
  // see the note on rateBuckets about pairing this with platform DDoS protection.
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    res.status(429).json({ error: "Too many requests. Slow down and try again shortly." });
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600");

  // Lazy single-track preview resolver: /api/playlist?preview=<trackId>
  const previewId = req.query && req.query.preview;
  if (previewId) {
    const tid = Array.isArray(previewId) ? previewId[0] : previewId;
    if (!/^[0-9A-Za-z]{22}$/.test(tid || "")) {
      res.status(400).json({ error: "Invalid track id." });
      return;
    }
    try {
      const preview = await fetchTrackPreview(tid);
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
      res.status(200).json({ id: tid, preview });
    } catch (_) {
      res.status(502).json({ error: "Couldn't read that track right now." });
    }
    return;
  }

  const raw = (req.query && (req.query.id || req.query.url)) || "";
  const parsed = parsePlaylistId(Array.isArray(raw) ? raw[0] : raw);

  if (parsed && parsed.error === "not-a-playlist") {
    res.status(400).json({ error: "That link is a Spotify track, album, or artist — paste a playlist link." });
    return;
  }
  if (!parsed || typeof parsed !== "string") {
    res.status(400).json({ error: "Paste a Spotify playlist link (open.spotify.com/playlist/…)." });
    return;
  }

  const id = parsed;
  try {
    const embed = await fetchEmbed(id);
    if (embed.notFound) {
      res.status(404).json({ error: "This playlist doesn't exist or isn't public." });
      return;
    }

    let tracks = embed.tracks;
    let truncated = false;

    // Only reach for the internal API when the embed may have been capped.
    if (embed.tracks.length >= EMBED_PAGE_CAP) {
      try {
        const full = await fetchAllViaPathfinder(id, embed.token);
        if (full.length) {
          // Pathfinder has every track but no previews; the embed has previews for the first 100.
          // Carry those previews over by track id so most of a large playlist plays immediately,
          // and the rest are resolved lazily client-side via ?preview=.
          const embedPreview = new Map(embed.tracks.filter((t) => t.id).map((t) => [t.id, t.preview]));
          for (const t of full) {
            if (t.id && t.preview == null && embedPreview.has(t.id)) t.preview = embedPreview.get(t.id);
          }
          tracks = full;
        }
      } catch (_) {
        truncated = true; // keep the embed's 100 tracks, flag it
      }
    }

    res.status(200).json({
      name: embed.name,
      cover: embed.cover,
      total: tracks.length,
      truncated,
      tracks
    });
  } catch (err) {
    res.status(502).json({ error: "Couldn't read that playlist from Spotify right now. Try again in a moment." });
  }
};
