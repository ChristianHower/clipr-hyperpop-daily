// CLIP//R — Endless mode. Paste a public Spotify playlist; guess its tracks from the shortest
// possible preview, round after round, on a health system. Loaded as an ES module by index.html.
"use strict";

import { $, escapeHtml, toast, openModal, closeModals, wireModalDismissal } from "./shared/dom.js";
import { normalize, label, formatDuration, sharesValue } from "./shared/text.js";
import { deezerJsonp } from "./shared/deezer.js";
import { clipSteps, maxAttempts, previewDuration, createPreviewPlayer } from "./shared/audio.js";

const RECENTS_KEY = "clipr-endless-recents";
const MAX_RECENTS = 6;
const SESSION_KEY = "clipr-endless-session";
const BEST_KEY = "clipr-endless-best"; // { [playlistId]: bestStreak } — persists per playlist

// ---- health system (v0.85) ----
// Start with 8 HP, capped at 8 (the +1 never overflows). Health changes by how much
// signal you needed to solve, indexed to clipSteps: solving on the 0.5s clip gains a
// point, 1s is neutral, and every longer clip costs one more, bottoming out at -4 at
// 16s. A full miss (all attempts used without solving) is an instant kill regardless of
// remaining health. Reaching 0 HP ends the session.
const MAX_HEALTH = 8;
const START_HEALTH = 8;
// Δ health per clip step, aligned to clipSteps = [0.5, 1, 2, 4, 8, 16].
const HEALTH_DELTA = [1, 0, -1, -2, -3, -4];
// How many tracks to resolve before the game starts; the rest stream in afterward.
const INITIAL_BATCH = 100;
// Reject playlists larger than this before any matching work happens.
const MAX_PLAYLIST_TRACKS = 1000;

const trackMetadata = new Map();
async function getTrackMetadata(trackId) {
  if (trackMetadata.has(trackId)) return trackMetadata.get(trackId);
  // Interactive: the current round and guess classification both wait on this, so it jumps
  // ahead of background playlist resolution in the limiter.
  const request = deezerLimited(() => deezerJsonp(`/track/${trackId}`), true).catch((error) => { trackMetadata.delete(trackId); throw error; });
  trackMetadata.set(trackId, request);
  const record = await request;
  trackMetadata.set(trackId, record);
  return record;
}
// Deezer rate limiter. Deezer's public API caps requests (~50 per 5s per IP) and returns
// "Quota limit exceeded" (error code 4) past that. Resolving a large playlist makes
// hundreds of calls, so without pacing most of them fail and the tracks get dropped —
// which is why unthrottled resolution found far fewer tracks in the browser than in
// sequential testing. This caps concurrency, spaces out request starts, and retries a
// quota rejection with backoff instead of discarding the track.
const deezerLimiter = (() => {
  const concurrency = 6;
  const minGapMs = 90;
  let active = 0;
  let lastStart = 0;
  // Two lanes: interactive requests (a guess classification, the current round's track
  // metadata) jump ahead of the bulk background playlist resolution so a guess never waits
  // behind hundreds of queued matching calls. Both lanes still share the same concurrency
  // and spacing, so the Deezer quota protection is unchanged.
  const priorityQueue = [];
  const backgroundQueue = [];
  const pump = () => {
    const queue = priorityQueue.length ? priorityQueue : backgroundQueue;
    if (!queue.length || active >= concurrency) return;
    const wait = Math.max(0, lastStart + minGapMs - Date.now());
    if (wait > 0) { setTimeout(pump, wait); return; }
    const job = queue.shift();
    active += 1;
    lastStart = Date.now();
    Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { active -= 1; pump(); });
    pump();
  };
  return (fn, priority = false) => new Promise((resolve, reject) => {
    (priority ? priorityQueue : backgroundQueue).push({ fn, resolve, reject });
    pump();
  });
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isQuotaError(error) { return /quota limit/i.test(error?.message || ""); }

// Run a Deezer request through the limiter, retrying quota rejections with backoff.
// Pass priority=true for interactive requests that a player is waiting on.
function deezerLimited(fn, priority = false) {
  return deezerLimiter(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { return await fn(); }
      catch (error) {
        if (isQuotaError(error) && attempt < 3) { await sleep(400 * (attempt + 1)); continue; }
        throw error;
      }
    }
    throw new Error("Deezer quota limit exceeded");
  }, priority);
}

// ---- session state ----
let tracks = [];           // resolved pool: { id, artist, title, soundcloud? }
let playlistMeta = null;   // { name, total, loaded, skipped, truncated }
let order = [];            // shuffled index queue
let orderPos = 0;
let round = 0;
let puzzle = null;
let state = { attempts: [], over: false, won: false };
let previewAudio = null;
let roundRun = 0;
let catalogReady = false;
let submittingGuess = false;
let suggestionIndex = -1;
let resolveToken = 0;      // invalidates background resolution when a new playlist loads
let backgroundResolving = false;
let currentPlaylistId = null;  // id of the loaded playlist (for persistence)
let pendingSpTracks = [];      // Spotify tracks not yet resolved (for persistence/resume)
let restoring = false;         // true while rehydrating a saved session
const session = { solved: 0, played: 0, streak: 0, best: 0, health: START_HEALTH, dead: false, dist: Array(maxAttempts).fill(0) };

const input = $("#guessInput");
const suggestions = $("#suggestions");
const timeline = $("#timeline");
const playbackFill = $("#playbackFill");
const playhead = $("#playhead");
const playButton = $("#playButton");
const resultPlayButton = $("#resultPlayButton");

// ---- preview playback engine (shared) ----
const player = createPreviewPlayer({
  els: { playButton, resultPlayButton, playbackFill, playhead },
  audio: () => previewAudio,
  isOver: () => state.over,
  ready: () => catalogReady,
  currentStep: () => currentStep(),
  toast,
  messages: { loading: "preview is still loading", blocked: "the browser blocked this preview" }
});
const stopPreview = player.stopPreview;
const playSignal = player.playSignal;

// ---- URL parsing (client-side quick check; server re-validates) ----
function parsePlaylistId(raw) {
  if (!raw) return null;
  const v = raw.trim();
  if (/^[0-9A-Za-z]{22}$/.test(v)) return v;
  let m = v.match(/spotify:playlist:([0-9A-Za-z]{22})/);
  if (m) return m[1];
  m = v.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([0-9A-Za-z]{22})/);
  if (m) return m[1];
  return null;
}

// ---- recents ----
function loadRecents() { try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); } catch (_) { return []; } }
function saveRecent(id, name) {
  let list = loadRecents().filter((r) => r.id !== id);
  list.unshift({ id, name });
  list = list.slice(0, MAX_RECENTS);
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (_) {}
  renderRecents();
}
function renderRecents() {
  const list = loadRecents();
  const wrap = $("#recentWrap");
  wrap.hidden = list.length === 0;
  const ul = $("#recentList");
  ul.innerHTML = "";
  list.forEach((r) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = r.name || r.id;
    b.addEventListener("click", () => startPlaylist(r.id));
    li.appendChild(b);
    ul.appendChild(li);
  });
}

// ---- session persistence (survives switching between Endless and Legacy) ----
// The resolved pool, rotation, scoreboard, health, and the in-progress round are saved to
// localStorage so navigating to /legacy and back resumes exactly where you left off. Only
// lightweight data is stored: per-track cover/preview/album metadata is re-fetched from
// Deezer by id on restore. Any tracks still streaming in the background when the snapshot
// is taken are kept as `pending` and resume resolving after a restore. The snapshot is
// never cleared automatically — loading a new playlist or restarting overwrites it.
function saveSession() {
  if (restoring) return;                 // don't clobber the snapshot mid-rehydrate
  if (!tracks.length || !currentPlaylistId) return;
  try {
    const snapshot = {
      v: 1,
      playlistId: currentPlaylistId,
      playlistMeta,
      tracks,                              // [{ id, artist, title }]
      pending: pendingSpTracks,            // unresolved Spotify tracks to resume
      order,
      orderPos,
      round,
      session,
      puzzleId: puzzle ? puzzle.id : null,
      roundState: puzzle ? { attempts: state.attempts, over: state.over, won: state.won, healthDelta: state.healthDelta ?? null } : null
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
  } catch (_) { /* quota or serialization issue — skip silently */ }
}

function loadSavedSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 1 || !Array.isArray(snap.tracks) || !snap.tracks.length) return null;
    return snap;
  } catch (_) { return null; }
}

function clearSavedSession() { try { localStorage.removeItem(SESSION_KEY); } catch (_) {} }

// Per-playlist best streak — persists across sessions/restarts on the same playlist.
function loadBestMap() { try { return JSON.parse(localStorage.getItem(BEST_KEY) || "{}") || {}; } catch (_) { return {}; } }
function getBest(playlistId) { if (!playlistId) return 0; const v = loadBestMap()[playlistId]; return Number.isFinite(v) ? v : 0; }
function recordBest(playlistId, value) {
  if (!playlistId || !Number.isFinite(value)) return;
  const map = loadBestMap();
  if (value > (map[playlistId] || 0)) {
    map[playlistId] = value;
    try { localStorage.setItem(BEST_KEY, JSON.stringify(map)); } catch (_) {}
  }
}

// ---- loading a playlist ----
function setLoaderStatus(text) { $("#loaderStatus").textContent = text || ""; }
function setProgress(done, total) {
  const bar = $("#loaderProgress");
  bar.hidden = false;
  $("#loaderProgressBar").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

async function fetchPlaylist(id) {
  const res = await fetch(`/api/playlist?id=${encodeURIComponent(id)}`);
  let payload = null;
  try { payload = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(payload?.error || "Couldn't load that playlist.");
  return payload;
}

async function startPlaylist(id) {
  $("#loadButton").disabled = true;
  $("#playlistInput").disabled = true;
  setLoaderStatus("Reading playlist from Spotify…");
  setProgress(0, 1);
  let data;
  try {
    data = await fetchPlaylist(id);
  } catch (err) {
    setLoaderStatus(err.message || "Couldn't load that playlist.");
    $("#loaderProgress").hidden = true;
    $("#loadButton").disabled = false;
    $("#playlistInput").disabled = false;
    return;
  }

  // v0.90: the song pool is built directly from Spotify's own data — no Deezer matching.
  // Each track already carries its id, title, artist(s), duration, and Spotify preview, so
  // the audio you hear is always the exact playlist track (no wrong-artist mismatches).
  const spTracks = (data.tracks || []).filter((t) => t.isPlayable !== false && t.title && t.id);

  if (!spTracks.length) {
    setLoaderStatus("This playlist has no playable tracks. Try another playlist.");
    $("#loaderProgress").hidden = true;
    $("#loadButton").disabled = false;
    $("#playlistInput").disabled = false;
    return;
  }

  // Reject oversized playlists.
  if (spTracks.length > MAX_PLAYLIST_TRACKS) {
    setLoaderStatus(`That playlist has ${spTracks.length} songs. Please link a playlist with fewer than ${MAX_PLAYLIST_TRACKS} songs.`);
    $("#loaderProgress").hidden = true;
    $("#loadButton").disabled = false;
    $("#playlistInput").disabled = false;
    return;
  }

  // Invalidate anything left over from a previous playlist.
  ++resolveToken;

  // Build the pool. De-dupe by track id. Preview may be null for tracks beyond the first
  // 100 of a large playlist — those are fetched lazily when the track is played.
  const seen = new Set();
  tracks = [];
  for (const t of spTracks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    tracks.push({
      id: t.id,
      title: t.title,
      artist: (t.artists && t.artists[0]) || "",
      artists: Array.isArray(t.artists) ? t.artists : [],
      album: t.album || null,
      durationMs: t.durationMs || null,
      preview: t.preview || null
    });
  }

  playlistMeta = {
    name: data.name || "Spotify playlist",
    total: data.total || tracks.length,
    loaded: tracks.length,
    skipped: 0,
    pending: 0,
    truncated: Boolean(data.truncated),
    cover: data.cover || null
  };
  saveRecent(id, playlistMeta.name);
  currentPlaylistId = id;
  pendingSpTracks = [];

  order = shuffle([...tracks.keys()]);
  orderPos = 0;
  round = 0;
  resetSessionStats();
  clearSavedSession();

  $("#loadButton").disabled = false;
  $("#playlistInput").disabled = false;
  $("#loaderProgress").hidden = true;
  $("#loaderView").hidden = true;
  $("#gameView").hidden = false;

  renderPlaylistBanner();
  updateScoreboard();
  nextRound();
  saveSession();
  toast(`Loaded ${playlistMeta.loaded} tracks`);
}

// Ensure a track has a playable preview URL, fetching it lazily from the server for tracks
// beyond the first 100 of a large playlist (pathfinder doesn't carry previews). Returns the
// preview URL or null. The result is cached on the track object.
async function ensurePreview(track) {
  if (track.preview) return track.preview;
  if (track._noPreview) return null;
  try {
    const res = await fetch(`/api/playlist?preview=${encodeURIComponent(track.id)}`);
    const payload = await res.json().catch(() => null);
    if (res.ok && payload && payload.preview) { track.preview = payload.preview; return track.preview; }
  } catch (_) {}
  track._noPreview = true;
  return null;
}

// Drop a track index into the still-unplayed part of the rotation at a random position.
function insertIntoRotation(trackIndex) {
  if (orderPos >= order.length) { order.push(trackIndex); return; }
  const span = order.length - orderPos;
  const at = orderPos + Math.floor(Math.random() * (span + 1));
  order.splice(at, 0, trackIndex);
}

function resetSessionStats() {
  session.solved = 0; session.played = 0; session.streak = 0;
  // Best streak carries over per playlist; seed it from the stored record.
  session.best = getBest(currentPlaylistId);
  session.health = START_HEALTH; session.dead = false;
  session.dist = Array(maxAttempts).fill(0);
}

// Restart = a brand-new session on the same already-loaded playlist: reshuffle the
// rotation, reset the round counter, stats, streak, and health, then deal a fresh round.
// The expensive Deezer-matched pool is kept as-is (no re-loading).
function restartSession() {
  if (!tracks.length) return;
  stopPreview();
  order = shuffle([...tracks.keys()]);
  orderPos = 0;
  round = 0;
  resetSessionStats();
  updateScoreboard();
  $("#nextTrackButton").hidden = false;
  $("#restartButton").hidden = true;
  nextRound();
  toast("new session · health restored");
}

function renderPlaylistBanner() {
  if (!playlistMeta) return;
  const bannerBits = [`${playlistMeta.name} · ${playlistMeta.loaded} playable`];
  if (playlistMeta.pending) bannerBits.push(`+${playlistMeta.pending} loading`);
  if (playlistMeta.skipped) bannerBits.push(`${playlistMeta.skipped} skipped`);
  if (playlistMeta.truncated) bannerBits.push("first 100 only");
  $("#playlistBannerText").textContent = bannerBits.join(" · ");
  $("#playlistBanner").hidden = false;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextTrackIndex() {
  if (orderPos >= order.length) { order = shuffle([...tracks.keys()]); orderPos = 0; }
  return order[orderPos++];
}

// ---- round lifecycle ----
// When `resume` is provided ({ selected, roundState }), rebuild that exact round (same
// puzzle + attempts so far) instead of drawing a new track — used when restoring a saved
// session after switching back from Legacy.
async function nextRound(resume) {
  if (!resume && session.dead) return; // session is over; player must restart
  const run = ++roundRun;
  stopPreview();
  catalogReady = false;
  submittingGuess = false;
  state = resume && resume.roundState
    ? { attempts: resume.roundState.attempts || [], over: !!resume.roundState.over, won: !!resume.roundState.won, healthDelta: resume.roundState.healthDelta ?? undefined }
    : { attempts: [], over: false, won: false };
  puzzle = null;
  if (resume) { round = resume.round; } else { round += 1; }
  $("#roundNumber").textContent = `#${round}`;
  input.value = "";
  input.placeholder = "Loading track…";
  suggestions.innerHTML = "";
  suggestions.classList.remove("open");
  suggestionIndex = -1;
  $("#transmissionAnswer").hidden = true;
  $("#transmissionAnswer").removeAttribute("href");
  $("#transmissionCover").removeAttribute("src");
  $("#transmissionTitle").textContent = "";
  $("#transmissionArtist").textContent = "";
  closeModals();
  render();

  const selected = resume ? resume.selected : tracks[nextTrackIndex()];
  try {
    // Spotify-native: the preview, title, and artist all come straight from the playlist
    // track. For tracks beyond the first 100 of a large playlist the preview is fetched
    // lazily here. Album artwork is pulled from Deezer only when the round is revealed.
    const preview = await ensurePreview(selected);
    if (run !== roundRun) return;
    if (!preview) throw new Error("preview unavailable");
    puzzle = {
      id: selected.id,
      artist: selected.artist,
      title: selected.title,
      artists: selected.artists || [selected.artist],
      album: selected.album || null,
      preview,
      spotify: `https://open.spotify.com/track/${selected.id}`,
      cover: null,          // filled lazily from Deezer on reveal
      deezerLink: null,
      // Normalized artist keys for the native ARTIST hint (no Deezer needed).
      artistKeys: [...new Set((selected.artists || [selected.artist]).map((n) => normalize(n)).filter(Boolean))]
    };
    previewAudio = new Audio(puzzle.preview);
    previewAudio.preload = "auto";
    previewAudio.addEventListener("error", () => { if (run === roundRun) { stopPreview(); toast("this preview is unavailable — skipping"); } });
    catalogReady = true;
    input.placeholder = "Search artist or track…";
    playButton.textContent = "▶";
    render();
    if (resume && state.over) { reveal(); } else { input.focus(); }
    if (!resume) saveSession();
  } catch (error) {
    if (run !== roundRun) return;
    // A dead track shouldn't trap the player — advance automatically.
    toast("a track was unavailable — loading another");
    setTimeout(() => { if (run === roundRun) nextRound(); }, 400);
  }
}

function currentStep() { return Math.min(state.attempts.length, clipSteps.length - 1); }
function currentDuration() { return state.over ? previewDuration : clipSteps[currentStep()]; }

// Classify a wrong guess for the yellow hint, using Spotify data only (no network call):
// ARTIST when the guessed track shares an artist with the answer; ALBUM when both carry an
// album name (pathfinder playlists) and they match. Otherwise a plain miss.
function classifyGuess(track, target) {
  const guessArtistKeys = [...new Set((track.artists || [track.artist]).map((n) => normalize(n)).filter(Boolean))];
  if (target.album && track.album && normalize(target.album) === normalize(track.album)) return "album";
  if (sharesValue(target.artistKeys || [], guessArtistKeys)) return "artist";
  return "guess";
}

function attemptClass(a) { if (!a) return ""; if (a.type === "skip") return "skiprow"; if (a.type === "artist" || a.type === "album") return "near"; return "wrong"; }
function attemptMark(a) { if (!a) return "—"; if (a.type === "skip") return "SKIP"; if (a.type === "artist") return "ARTIST"; if (a.type === "album") return "ALBUM"; return "MISS"; }

function render() {
  const step = currentStep();
  document.querySelectorAll(".segment").forEach((segment, index) => {
    const isUnlocked = state.over || index <= step;
    segment.classList.toggle("unlocked", isUnlocked);
    segment.classList.toggle("used", Boolean(state.attempts[index]));
    const durationLabel = formatDuration(Number(segment.dataset.seconds));
    segment.setAttribute("aria-label", `${durationLabel} ${isUnlocked ? "unlocked" : "locked"}`);
  });
  const duration = currentDuration();
  $("#clipLength").textContent = catalogReady ? formatDuration(duration) : "loading preview";
  playButton.setAttribute("aria-label", catalogReady ? `Play ${formatDuration(duration)} preview` : "Loading preview");
  $("#sideCounter").textContent = `${state.attempts.length} / ${maxAttempts}`;
  const attemptsLeft = maxAttempts - state.attempts.length;
  if (state.over) {
    $("#attemptText").textContent = state.won ? "signal identified" : "transmission ended";
  } else {
    const d = HEALTH_DELTA[currentStep()] || 0;
    const stake = d > 0 ? `solve now: +${d} health` : d < 0 ? `solve now: −${Math.abs(d)} health` : "solve now: no change";
    $("#attemptText").textContent = `${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left · ${stake}`;
  }
  playButton.disabled = !catalogReady;
  input.disabled = !catalogReady || state.over || submittingGuess;
  $("#submitGuess").disabled = !catalogReady || state.over || submittingGuess;
  $("#submitGuess").textContent = submittingGuess ? "checking…" : "guess";
  $("#skipButton").disabled = !catalogReady || state.over || submittingGuess;
  // When the round is over but the session is still alive, offer a Continue button on the
  // game screen so the player can advance even if they dismissed the result modal.
  $("#continueButton").hidden = !(state.over && !session.dead);

  const list = $("#attemptList");
  list.innerHTML = "";
  for (let i = 0; i < maxAttempts; i++) {
    const item = document.createElement("li");
    const attempt = state.attempts[i];
    item.className = attemptClass(attempt);
    item.innerHTML = `<span class="n">0${i + 1}</span><span class="text ${attempt ? "" : "empty"}">${attempt ? escapeHtml(attempt.text) : "Waiting for input"}</span><span class="mark">${attemptMark(attempt)}</span>`;
    list.appendChild(item);
  }
}

function updateScoreboard() {
  $("#scoreStreak").textContent = session.streak;
  $("#scoreBest").textContent = session.best;
  $("#scoreSolved").textContent = session.solved;
  renderHealth();
}

function renderHealth() {
  const wrap = $("#healthPips");
  if (!wrap) return;
  $("#healthValue").textContent = `${session.health}/${MAX_HEALTH}`;
  wrap.innerHTML = "";
  for (let i = 0; i < MAX_HEALTH; i++) {
    const pip = document.createElement("span");
    pip.className = "pip" + (i < session.health ? " on" : "");
    wrap.appendChild(pip);
  }
}

function filteredTracks() {
  const query = normalize(input.value);
  if (!query) return []; // no suggestions until the player starts typing
  const matches = tracks.filter((t) => normalize(label(t)).includes(query));
  return matches.sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true })
    || a.artist.localeCompare(b.artist, undefined, { sensitivity: "base", numeric: true })
  ).slice(0, 40);
}

function showSuggestions() {
  const options = filteredTracks();
  suggestions.innerHTML = "";
  suggestionIndex = -1;
  options.forEach((track) => {
    const button = document.createElement("button");
    button.className = "suggestion";
    button.type = "button";
    button.setAttribute("role", "option");
    button.innerHTML = `<strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)}</small>`;
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      input.value = label(track);
      suggestions.classList.remove("open");
      input.focus();
    });
    suggestions.appendChild(button);
  });
  const inputRect = input.getBoundingClientRect();
  const roomBelow = window.innerHeight - inputRect.bottom - 16;
  const roomAbove = inputRect.top - 16;
  const openAbove = roomBelow < 240 && roomAbove > roomBelow;
  suggestions.classList.toggle("above", openAbove);
  suggestions.style.maxHeight = `${Math.max(96, Math.min(360, openAbove ? roomAbove : roomBelow) - 8)}px`;
  suggestions.classList.toggle("open", options.length > 0 && !state.over);
}

input.addEventListener("focus", showSuggestions);
input.addEventListener("input", showSuggestions);
input.addEventListener("blur", () => setTimeout(() => suggestions.classList.remove("open"), 120));
input.addEventListener("keydown", (event) => {
  const options = [...suggestions.querySelectorAll(".suggestion")];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    suggestionIndex = event.key === "ArrowDown" ? Math.min(suggestionIndex + 1, options.length - 1) : Math.max(suggestionIndex - 1, 0);
    options.forEach((option, index) => option.classList.toggle("active", index === suggestionIndex));
  } else if (event.key === "Enter" && suggestionIndex >= 0) {
    event.preventDefault();
    options[suggestionIndex].dispatchEvent(new MouseEvent("mousedown"));
  } else if (event.key === "Enter") submitGuess();
  else if (event.key === "Escape") suggestions.classList.remove("open");
});

async function submitGuess() {
  if (!catalogReady || state.over || submittingGuess) return;
  const submissionRun = roundRun;
  const submissionState = state;
  const submissionPuzzle = puzzle;
  const typed = input.value.trim();
  if (!typed) return toast("choose a track first");
  const selected = tracks.find((t) => normalize(label(t)) === normalize(typed));
  if (!selected) return toast("pick a track from the list");
  if (selected.id === puzzle.id) {
    state.over = true;
    state.won = true;
    recordResult(true);
    render();
    reveal();
  } else {
    // Classification is now synchronous (Spotify data only), so register the miss with the
    // correct ARTIST/ALBUM/MISS marker in one step and unlock the next clip immediately.
    suggestions.classList.remove("open");
    const guessType = classifyGuess(selected, submissionPuzzle);
    submissionState.attempts.push({ type: guessType, text: label(selected) });
    input.value = "";
    if (submissionState.attempts.length >= maxAttempts) finishLoss();
    render();
    if (!state.over) {
      saveSession();
      if (guessType === "album") toast("same album — more signal unlocked");
      else if (guessType === "artist") toast("right artist — more signal unlocked");
      else toast("nope — more signal unlocked");
    }
  }
}

function skip() {
  if (!catalogReady || state.over || submittingGuess) return;
  state.attempts.push({ type: "skip", text: "Skipped" });
  if (state.attempts.length >= maxAttempts) finishLoss();
  render();
  if (!state.over) saveSession();
}

function finishLoss() {
  state.over = true;
  state.won = false;
  recordResult(false);
  const lossRun = roundRun;
  setTimeout(() => { if (lossRun === roundRun && state.over) reveal(); }, 180);
}

function recordResult(won) {
  session.played += 1;
  if (won) {
    session.solved += 1;
    session.streak += 1;
    session.best = Math.max(session.best, session.streak);
    recordBest(currentPlaylistId, session.best); // persist per-playlist best across sessions
    const step = Math.min(state.attempts.length, maxAttempts - 1);
    session.dist[step] += 1;
    // Health change is keyed to the clip the player solved on.
    const delta = HEALTH_DELTA[step] || 0;
    session.health = Math.min(MAX_HEALTH, Math.max(0, session.health + delta));
    state.healthDelta = delta;
  } else {
    // A full miss is an instant kill, regardless of remaining health.
    session.streak = 0;
    session.health = 0;
    state.healthDelta = null; // signals "wiped out"
  }
  if (session.health <= 0) session.dead = true;
  updateScoreboard();
  saveSession();
}

function setRevealCover(url) {
  $("#answerCover").src = url || "";
  $("#answerCover").alt = url ? `${puzzle ? puzzle.title : ""} cover art` : "";
  $("#transmissionCover").src = url || "";
  $("#transmissionCover").alt = url ? `${puzzle ? puzzle.title : ""} cover art` : "";
}

// Image-only Deezer lookup for the revealed song's album art + Deezer link. Runs once per
// solved/lost round (lazy), not during playlist load. A wrong match here only affects the
// thumbnail — never the song you heard — so it can't corrupt the game.
const artworkCache = new Map();
async function enrichArtwork(p) {
  if (artworkCache.has(p.id)) return artworkCache.get(p.id);
  const promise = (async () => {
    try {
      const q = `${p.artist} ${p.title}`.trim();
      const data = await deezerJsonp(`/search/track?q=${encodeURIComponent(q)}&limit=5`);
      const rows = (data && data.data) || [];
      const want = normalize(p.title);
      const wantArtist = normalize(p.artist);
      // Prefer a row matching both title and artist; fall back to the first with a cover.
      let best = rows.find((r) => normalize(r.title) === want && normalize(r.artist?.name || "").includes(wantArtist))
        || rows.find((r) => normalize(r.title) === want)
        || rows[0];
      if (!best) return null;
      return {
        cover: best.album?.cover_big || best.album?.cover_medium || best.album?.cover || null,
        link: best.link || null
      };
    } catch (_) { return null; }
  })();
  artworkCache.set(p.id, promise);
  return promise;
}

function reveal() {
  if (!puzzle || !state.over) return;
  const dead = session.dead;
  const revealRun = roundRun;
  $("#resultKicker").textContent = dead ? "Flatline" : (state.won ? "Signal found" : "Signal lost");
  $("#resultTitle").textContent = dead ? "game over." : (state.won ? "nailed it." : "too loud.");
  $("#answerTrack").textContent = puzzle.title;
  $("#answerArtist").textContent = puzzle.artist;
  // Links now point at Spotify (the source of truth), replacing the old SoundCloud search.
  $("#resultSongLink").href = puzzle.spotify;
  $("#resultSongLink").setAttribute("aria-label", `Open ${puzzle.artist} — ${puzzle.title} on Spotify`);
  $("#transmissionTitle").textContent = puzzle.title;
  $("#transmissionArtist").textContent = puzzle.artist;
  $("#transmissionAnswer").href = puzzle.spotify;
  $("#transmissionAnswer").setAttribute("aria-label", `Open ${puzzle.artist} — ${puzzle.title} on Spotify`);
  $("#transmissionAnswer").hidden = false;

  // Artwork: show the puzzle's cover if we already fetched it, otherwise the playlist cover
  // as an immediate placeholder, then enrich with the song's own Deezer cover lazily.
  const placeholder = puzzle.cover || (playlistMeta && playlistMeta.cover) || "";
  setRevealCover(placeholder);
  $("#deezerLink").href = puzzle.deezerLink || puzzle.spotify;
  if (!puzzle.cover) {
    enrichArtwork(puzzle).then((info) => {
      if (!info || revealRun !== roundRun) return;
      if (info.cover) { puzzle.cover = info.cover; setRevealCover(info.cover); }
      if (info.link) { puzzle.deezerLink = info.link; $("#deezerLink").href = info.link; }
    }).catch(() => {});
  }
  let copy;
  if (session.dead) {
    copy = state.won
      ? `Solved with ${formatDuration(clipSteps[currentStep()])} of signal, but that −${Math.abs(state.healthDelta)} drained the last of your health. You solved ${session.solved} · best streak ${session.best}. Restart to run it back.`
      : `You ran out of signal and flatlined. You solved ${session.solved} · best streak ${session.best}. Restart to run it back.`;
  } else if (state.won) {
    const d = state.healthDelta;
    const healthNote = d > 0 ? `+${d} health` : d < 0 ? `−${Math.abs(d)} health` : "no health lost";
    copy = `You got it with ${formatDuration(clipSteps[currentStep()])} of signal — ${healthNote}. Health ${session.health}/${MAX_HEALTH} · streak ${session.streak}.`;
  } else {
    copy = "Full miss — you flatlined. Restart to run it back.";
  }
  $("#resultCopy").textContent = copy;

  // When the session is over, the result modal offers a restart instead of next track.
  $("#nextTrackButton").hidden = session.dead;
  $("#restartButton").hidden = !session.dead;
  openModal("resultModal");
}

// ---- modal + control wiring ----
wireModalDismissal();

$("#submitGuess").addEventListener("click", submitGuess);
$("#skipButton").addEventListener("click", skip);
playButton.addEventListener("click", playSignal);
resultPlayButton.addEventListener("click", playSignal);
$("#nextTrackButton").addEventListener("click", () => { closeModals(); nextRound(); });
$("#continueButton").addEventListener("click", () => { closeModals(); nextRound(); });
$("#restartButton").addEventListener("click", () => { closeModals(); restartSession(); });
$("#restartInline").addEventListener("click", () => restartSession());

$("#changePlaylistButton").addEventListener("click", () => {
  resolveToken += 1; // stop any background resolution from the current playlist
  backgroundResolving = false;
  stopPreview();
  $("#gameView").hidden = true;
  $("#loaderView").hidden = false;
  $("#playlistInput").focus();
});

$("#loaderForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = parsePlaylistId($("#playlistInput").value);
  if (!id) { setLoaderStatus("That doesn't look like a Spotify playlist link."); return; }
  startPlaylist(id);
});

// ---- restore a saved session on load (e.g. after switching back from Legacy) ----
async function restoreSession(snap) {
  restoring = true;
  try {
    tracks = snap.tracks;
    playlistMeta = snap.playlistMeta || null;
    currentPlaylistId = snap.playlistId || null;
    pendingSpTracks = Array.isArray(snap.pending) ? snap.pending : [];
    order = Array.isArray(snap.order) && snap.order.length ? snap.order : shuffle([...tracks.keys()]);
    orderPos = Number.isInteger(snap.orderPos) ? snap.orderPos : 0;
    round = Number.isInteger(snap.round) ? snap.round : 0;
    if (snap.session && typeof snap.session === "object") {
      Object.assign(session, snap.session);
      if (!Array.isArray(session.dist)) session.dist = Array(maxAttempts).fill(0);
    }
    // Reconcile with the persisted per-playlist best (may be higher from another session).
    session.best = Math.max(session.best || 0, getBest(currentPlaylistId));
    recordBest(currentPlaylistId, session.best);

    $("#loaderView").hidden = true;
    $("#gameView").hidden = false;
    renderPlaylistBanner();
    updateScoreboard();

    // Rebuild the exact round the player was on, by track id.
    const selected = (snap.puzzleId != null && tracks.find((t) => t.id === snap.puzzleId)) || null;
    if (selected) {
      await nextRound({ selected, roundState: snap.roundState, round });
    } else {
      // No recoverable current puzzle — deal a fresh round (unless the run had ended).
      if (session.dead) { restoring = false; $("#restartButton").hidden = false; $("#nextTrackButton").hidden = true; return; }
      round = Math.max(0, round - 1); // nextRound will increment
      await nextRound();
    }
  } catch (_) {
    // Corrupt snapshot — fall back to the loader.
    $("#gameView").hidden = true;
    $("#loaderView").hidden = false;
  } finally {
    restoring = false;
  }

  toast("resumed your session");
}

// Flush the latest state when the page is hidden or unloaded, so a navigation to Legacy
// (or closing the tab) always captures the current round.
window.addEventListener("pagehide", saveSession);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveSession(); });

renderRecents();
const saved = loadSavedSession();
if (saved) {
  restoreSession(saved);
} else {
  $("#playlistInput").focus();
}
