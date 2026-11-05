// CLIP//R — Legacy daily mode. Everyone gets the same curated track each day; guess it from the
// shortest possible preview. Also serves the 4-day archive. Loaded as an ES module by legacy.html.

import { $, escapeHtml, toast, openModal, closeModals, wireModalDismissal } from "./shared/dom.js";
import { normalize, label, formatDuration, artistIds, artistKeys, sharesValue } from "./shared/text.js";
import { deezerJsonp } from "./shared/deezer.js";
import { clipSteps, maxAttempts, previewDuration, createPreviewPlayer } from "./shared/audio.js";
import { CLIPR_CATALOG } from "./catalog.js";

let tracks = [];

const launchDay = Date.UTC(2026, 8, 11);
const maxArchiveDays = 4;
const millisecondsPerDay = 86400000;

function todayEasternKey() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function utcDayFromKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function dateKeyFromUtcDay(utcDay) {
  return new Date(utcDay).toISOString().slice(0, 10);
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dateKeyFromUtcDay(utcDayFromKey(value)) === value;
}

function dayInfoFor(dateKey) {
  const dayIndex = Math.max(0, Math.floor((utcDayFromKey(dateKey) - launchDay) / 86400000));
  return { dateKey, dayKey: `clipr-${dateKey}`, dayIndex, puzzleNo: dayIndex + 1 };
}

function loadState(dayKey) {
  let loaded = { attempts: [], over: false, won: false };
  try { loaded = { ...loaded, ...JSON.parse(localStorage.getItem(dayKey) || "{}") }; } catch (_) {}
  return loaded;
}

const todayKey = todayEasternKey();
let activeDay = dayInfoFor(todayKey);
let state = loadState(activeDay.dayKey);
let puzzle = null;
let previewAudio = null;
let catalogReady = false;
let submittingGuess = false;
let agentToolsRegistered = false;
let queueDays = [];
let puzzleLoadRun = 0;
const trackMetadata = new Map();

const input = $("#guessInput");
const suggestions = $("#suggestions");
const timeline = $("#timeline");
const playbackFill = $("#playbackFill");
const playhead = $("#playhead");
const playButton = $("#playButton");
const resultPlayButton = $("#resultPlayButton");
let suggestionIndex = -1;

// ---- preview playback engine (shared) ----
const player = createPreviewPlayer({
  els: { playButton, resultPlayButton, playbackFill, playhead },
  audio: () => previewAudio,
  isOver: () => state.over,
  ready: () => catalogReady,
  currentStep: () => currentStep(),
  toast,
  messages: { loading: "Deezer preview is still loading", blocked: "Deezer blocked this preview" }
});
const stopPreview = player.stopPreview;
const playSignal = player.playSignal;

function updateModeUI() {
  $("#puzzleNumber").textContent = `#${String(activeDay.puzzleNo).padStart(4, "0")}`;
  const isToday = activeDay.dateKey === todayKey;
  const banner = $("#archiveBanner");
  banner.hidden = isToday;
  $(".prompt").textContent = isToday
    ? "Identify today’s track in as few seconds as possible. A wrong guess or skip unlocks a longer clip."
    : "Identify this archived track in as few seconds as possible. A wrong guess or skip unlocks a longer clip.";
  if (!isToday) {
    const label = new Date(`${activeDay.dateKey}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    $("#archiveBannerText").textContent = `Replaying ${label}`;
  }
}
updateModeUI();

async function getTrackMetadata(trackId) {
  if (trackMetadata.has(trackId)) return trackMetadata.get(trackId);
  const request = deezerJsonp(`/track/${trackId}`).catch((error) => {
    trackMetadata.delete(trackId);
    throw error;
  });
  trackMetadata.set(trackId, request);
  const record = await request;
  trackMetadata.set(trackId, record);
  return record;
}

function validatedQueueDays(value) {
  if (!Array.isArray(value)) return [];
  const catalogIds = new Set((CLIPR_CATALOG || []).map((track) => Number(track.deezerId)));
  const seenDates = new Set();
  return value.filter((entry) => {
    const valid = entry && isDateKey(entry.date) && utcDayFromKey(entry.date) >= launchDay &&
      Number.isFinite(Number(entry.deezerId)) && catalogIds.has(Number(entry.deezerId)) &&
      typeof entry.artist === "string" && entry.artist.trim() &&
      typeof entry.title === "string" && entry.title.trim() && !seenDates.has(entry.date);
    if (!valid) console.warn("Ignoring invalid CLIP//R queue entry", entry);
    else seenDates.add(entry.date);
    return Boolean(valid);
  }).sort((a, b) => a.date.localeCompare(b.date));
}

async function loadQueue() {
  try {
    const response = await fetch(`queue.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return [];
    const payload = await response.json();
    return validatedQueueDays(Array.isArray(payload) ? payload : payload.days);
  } catch (_) {
    return [];
  }
}

async function loadPuzzle(dateKey) {
  if (!isDateKey(dateKey) || utcDayFromKey(dateKey) < launchDay || utcDayFromKey(dateKey) > utcDayFromKey(todayKey)) {
    toast("that transmission is unavailable");
    return;
  }
  const loadRun = ++puzzleLoadRun;
  stopPreview();
  catalogReady = false;
  submittingGuess = false;
  activeDay = dayInfoFor(dateKey);
  state = loadState(activeDay.dayKey);
  puzzle = null;
  input.value = "";
  input.placeholder = "Loading track catalog…";
  suggestions.innerHTML = "";
  suggestions.classList.remove("open");
  suggestionIndex = -1;
  $("#transmissionAnswer").hidden = true;
  $("#transmissionCover").removeAttribute("src");
  $("#transmissionCover").alt = "";
  $("#transmissionTitle").textContent = "";
  $("#transmissionArtist").textContent = "";
  $("#resultModal").classList.remove("open");
  updateModeUI();
  render();
  try {
    tracks = (CLIPR_CATALOG || []).map((track) => ({ ...track, id: Number(track.deezerId) }));
    if (!tracks.length) throw new Error("The CLIP//R catalog is empty");
    const scheduled = queueDays.find((entry) => entry.date === dateKey);
    const requestedDay = dayInfoFor(dateKey);
    const selected = tracks.find((track) => track.id === Number(scheduled?.deezerId)) || tracks[((requestedDay.dayIndex % tracks.length) + tracks.length) % tracks.length];
    const record = await getTrackMetadata(selected.id);
    if (loadRun !== puzzleLoadRun || activeDay.dateKey !== dateKey) return;
    if (!record.readable || !record.preview) throw new Error("This transmission’s preview is unavailable in this region");
    puzzle = {
      ...selected,
      artist: record.artist?.name || selected.artist,
      title: record.title || selected.title,
      albumId: Number(record.album?.id) || null,
      albumKey: normalize(record.album?.title || ""),
      artistIds: artistIds(record),
      artistKeys: artistKeys(record, selected.artist),
      preview: record.preview,
      link: record.link,
      cover: record.album?.cover_big || record.album?.cover_medium || null,
      soundcloud: selected.soundcloud || `https://soundcloud.com/search/sounds?q=${encodeURIComponent(`${selected.artist} ${selected.title}`)}`
    };
    previewAudio = new Audio(puzzle.preview);
    previewAudio.preload = "auto";
    previewAudio.addEventListener("error", () => {
      if (loadRun !== puzzleLoadRun) return;
      stopPreview();
      toast("this transmission’s Deezer preview is unavailable");
    });
    catalogReady = true;
    input.placeholder = "Search artist or track…";
    playButton.textContent = "▶";
    render();
    if (!agentToolsRegistered) { registerAgentTools(); agentToolsRegistered = true; }
    if (state.over) setTimeout(() => {
      if (loadRun === puzzleLoadRun && activeDay.dateKey === dateKey && state.over) populateAnswer();
    }, 250);
  } catch (error) {
    if (loadRun !== puzzleLoadRun || activeDay.dateKey !== dateKey) return;
    $("#clipLength").textContent = "preview unavailable";
    input.placeholder = "Deezer catalog unavailable";
    toast(error.message || "Deezer catalog unavailable");
  }
}

function currentStep() { return Math.min(state.attempts.length, clipSteps.length - 1); }
function currentDuration() { return state.over ? previewDuration : clipSteps[currentStep()]; }
function persist(day = activeDay, gameState = state) { localStorage.setItem(day.dayKey, JSON.stringify(gameState)); }

async function classifyGuess(track, targetPuzzle) {
  const record = await getTrackMetadata(track.id);
  const guessedAlbumId = Number(record.album?.id) || null;
  const guessedAlbumKey = normalize(record.album?.title || "");
  if ((targetPuzzle.albumId && guessedAlbumId === targetPuzzle.albumId) || (targetPuzzle.albumKey && guessedAlbumKey === targetPuzzle.albumKey)) return "album";
  if (sharesValue(targetPuzzle.artistIds, artistIds(record)) || sharesValue(targetPuzzle.artistKeys, artistKeys(record, track.artist))) return "artist";
  return "guess";
}

function attemptClass(attempt) {
  if (!attempt) return "";
  if (attempt.type === "skip") return "skiprow";
  if (attempt.type === "artist" || attempt.type === "album") return "near";
  return "wrong";
}

function attemptMark(attempt) {
  if (!attempt) return "—";
  if (attempt.type === "skip") return "SKIP";
  if (attempt.type === "artist") return "ARTIST";
  if (attempt.type === "album") return "ALBUM";
  return "MISS";
}

function render() {
  const step = currentStep();
  document.querySelectorAll(".segment").forEach((segment, index) => {
    const isUnlocked = state.over || index <= step;
    segment.classList.toggle("unlocked", isUnlocked);
    segment.classList.toggle("used", Boolean(state.attempts[index]));
    const durationLabel = formatDuration(Number(segment.dataset.seconds));
    segment.setAttribute("aria-label", `${durationLabel} ${isUnlocked ? "unlocked" : "locked"}`);
  });
  timeline.classList.toggle("complete", state.over);
  const duration = currentDuration();
  $("#clipLength").textContent = catalogReady ? formatDuration(duration) : "loading preview";
  playButton.setAttribute("aria-label", catalogReady ? `Play ${formatDuration(duration)} preview` : "Loading Deezer preview");
  $("#sideCounter").textContent = `${state.attempts.length} / ${maxAttempts}`;
  const attemptsLeft = maxAttempts - state.attempts.length;
  $("#attemptText").textContent = state.over ? (state.won ? "signal identified" : "transmission ended") : `${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left`;
  playButton.disabled = !catalogReady;
  input.disabled = !catalogReady || state.over || submittingGuess;
  $("#submitGuess").disabled = !catalogReady || state.over || submittingGuess;
  $("#submitGuess").textContent = submittingGuess ? "checking…" : "guess";
  $("#skipButton").disabled = !catalogReady || state.over || submittingGuess;
  $("#skipButton").textContent = "Skip";

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

function filteredTracks() {
  const query = normalize(input.value);
  const matches = query
    ? tracks.filter((track) => normalize(label(track)).includes(query))
    : [...tracks];
  return matches.sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true })
    || a.artist.localeCompare(b.artist, undefined, { sensitivity: "base", numeric: true })
  ).slice(0, 7);
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
  const openAbove = roomBelow < 196 && roomAbove > roomBelow;
  suggestions.classList.toggle("above", openAbove);
  suggestions.style.maxHeight = `${Math.max(96, Math.min(196, openAbove ? roomAbove : roomBelow) - 8)}px`;
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
  const submissionRun = puzzleLoadRun;
  const submissionDay = activeDay;
  const submissionState = state;
  const submissionPuzzle = puzzle;
  const typed = input.value.trim();
  if (!typed) return toast("choose a track first");
  const selected = tracks.find((track) => normalize(label(track)) === normalize(typed));
  if (!selected) return toast("pick a track from the list");
  if (selected.id === puzzle.id) {
    state.over = true;
    state.won = true;
    updateStats(true);
    persist();
    render();
    reveal();
  } else {
    submittingGuess = true;
    suggestions.classList.remove("open");
    render();
    let guessType = "guess";
    try { guessType = await classifyGuess(selected, submissionPuzzle); } catch (_) {}
    if (submissionRun !== puzzleLoadRun || activeDay.dayKey !== submissionDay.dayKey || state !== submissionState) return;
    submittingGuess = false;
    submissionState.attempts.push({ type: guessType, text: label(selected) });
    input.value = "";
    if (submissionState.attempts.length >= maxAttempts) finishLoss();
    persist(submissionDay, submissionState);
    render();
    if (!state.over) {
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
  persist();
  render();
}

function finishLoss() {
  state.over = true;
  state.won = false;
  updateStats(false);
  const lossRun = puzzleLoadRun;
  const lossDayKey = activeDay.dayKey;
  setTimeout(() => {
    if (lossRun === puzzleLoadRun && activeDay.dayKey === lossDayKey && state.over) reveal();
  }, 180);
}

function updateStats(won) {
  if (activeDay.dateKey !== todayKey) return;
  let stats = { played: 0, wins: 0, streak: 0, lastDay: null };
  try { stats = { ...stats, ...JSON.parse(localStorage.getItem("clipr-stats") || "{}") }; } catch (_) {}
  if (stats.lastDay === activeDay.dayKey) return;
  const lastDateKey = typeof stats.lastDay === "string" ? stats.lastDay.replace(/^clipr-/, "") : null;
  const yesterdayKey = dateKeyFromUtcDay(utcDayFromKey(activeDay.dateKey) - millisecondsPerDay);
  stats.played += 1;
  stats.wins += won ? 1 : 0;
  stats.streak = won ? (lastDateKey === yesterdayKey ? stats.streak + 1 : 1) : 0;
  stats.lastDay = activeDay.dayKey;
  localStorage.setItem("clipr-stats", JSON.stringify(stats));
}

function reveal() {
  if (!puzzle || !state.over) return;
  populateAnswer();
  openModal("resultModal");
}

function populateAnswer() {
  if (!puzzle || !state.over) return;
  $("#resultKicker").textContent = state.won ? "Signal found" : "Signal lost";
  $("#resultTitle").textContent = state.won ? "nailed it." : "too loud.";
  $("#answerTrack").textContent = puzzle.title;
  $("#answerArtist").textContent = puzzle.artist;
  $("#resultSongLink").href = puzzle.soundcloud;
  $("#resultSongLink").setAttribute("aria-label", `Open ${puzzle.artist} — ${puzzle.title} on SoundCloud`);
  $("#answerCover").src = puzzle.cover || "";
  $("#answerCover").alt = puzzle.cover ? `${puzzle.title} cover art` : "";
  $("#transmissionTitle").textContent = puzzle.title;
  $("#transmissionArtist").textContent = puzzle.artist;
  $("#transmissionCover").src = puzzle.cover || "";
  $("#transmissionCover").alt = puzzle.cover ? `${puzzle.title} cover art` : "";
  $("#transmissionAnswer").setAttribute("aria-label", `Show ${puzzle.artist} — ${puzzle.title} result`);
  $("#transmissionAnswer").hidden = false;
  $("#deezerLink").href = puzzle.link;
  $("#resultCopy").textContent = state.won
    ? `You got it with ${formatDuration(clipSteps[currentStep()])} of signal.`
    : (activeDay.dateKey === todayKey ? "Come back tomorrow for another transmission." : "Return to the archive or try today’s transmission.");
}

// ---- modal + control wiring ----
wireModalDismissal();

$("#submitGuess").addEventListener("click", submitGuess);
$("#skipButton").addEventListener("click", skip);
playButton.addEventListener("click", playSignal);
resultPlayButton.addEventListener("click", playSignal);
$("#shareButton").addEventListener("click", async () => {
  const marks = state.attempts.map((a) => a.type === "skip" ? "⬛" : (a.type === "artist" || a.type === "album") ? "🟨" : "🟥").join("") + (state.won ? "🟩" : "");
  const result = `CLIP//R #${activeDay.puzzleNo} ${state.won ? `${state.attempts.length + 1}/${maxAttempts}` : `X/${maxAttempts}`}\n${marks}`;
  try { await navigator.clipboard.writeText(result); toast("result copied"); } catch (_) { toast("copy unavailable"); }
});

function registerAgentTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const tools = [
    {
      name: "get_daily_game_state",
      title: "Get active game state",
      description: "Read the active CLIP//R puzzle's date, mode, number, unlocked clip length, remaining attempts, and available track choices without revealing the answer.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute() {
        return {
          dateKey: activeDay.dateKey,
          mode: activeDay.dateKey === todayKey ? "daily" : "archive",
          puzzleNumber: activeDay.puzzleNo,
          clipSeconds: clipSteps[currentStep()],
          attemptsRemaining: Math.max(0, maxAttempts - state.attempts.length),
          complete: state.over,
          won: state.over ? state.won : null,
          choices: tracks.map((track) => ({ artist: track.artist, title: track.title }))
        };
      }
    },
    {
      name: "submit_track_guess",
      title: "Submit track guess",
      description: "Submit one artist and track combination as the next guess in the active CLIP//R game.",
      inputSchema: {
        type: "object",
        properties: { artist: { type: "string" }, title: { type: "string" } },
        required: ["artist", "title"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(value) {
        if (state.over) throw new Error("The active game is already complete.");
        const requestedDayKey = activeDay.dayKey;
        const selected = tracks.find((track) => normalize(track.artist) === normalize(value?.artist || "") && normalize(track.title) === normalize(value?.title || ""));
        if (!selected) throw new Error("Choose an artist and track from the available choices.");
        input.value = label(selected);
        await submitGuess();
        if (activeDay.dayKey !== requestedDayKey) throw new Error("The active puzzle changed before the guess finished.");
        return { dateKey: activeDay.dateKey, mode: activeDay.dateKey === todayKey ? "daily" : "archive", correct: state.over && state.won, complete: state.over, attemptsRemaining: Math.max(0, maxAttempts - state.attempts.length), clipSeconds: clipSteps[currentStep()] };
      }
    },
    {
      name: "skip_game_attempt",
      title: "Skip game attempt",
      description: "Use one attempt to unlock a longer audio preview in the active CLIP//R game.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute() {
        if (state.over) throw new Error("The active game is already complete.");
        skip();
        return { dateKey: activeDay.dateKey, mode: activeDay.dateKey === todayKey ? "daily" : "archive", complete: state.over, attemptsRemaining: Math.max(0, maxAttempts - state.attempts.length), clipSeconds: clipSteps[currentStep()] };
      }
    }
  ];
  tools.forEach((tool) => {
    try { void Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch (_) {}
  });
}

function archiveState(dateKey) {
  try { return JSON.parse(localStorage.getItem(`clipr-${dateKey}`) || "{}"); } catch (_) { return {}; }
}

function buildArchiveEntries() {
  const todayUtc = utcDayFromKey(todayKey);
  return Array.from({ length: maxArchiveDays }, (_, index) => ({
    date: dateKeyFromUtcDay(todayUtc - ((index + 1) * millisecondsPerDay))
  })).filter((entry) => utcDayFromKey(entry.date) >= launchDay);
}

function renderArchiveList() {
  const list = $("#archiveList");
  list.innerHTML = "";
  const entries = buildArchiveEntries();
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "archive-empty";
    empty.textContent = "No archived transmissions yet.";
    list.appendChild(empty);
    return;
  }
  entries.forEach((entry) => {
    const info = dayInfoFor(entry.date);
    const dateLabel = new Date(`${entry.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    const saved = archiveState(entry.date);
    const item = document.createElement("li");
    item.className = "archive-row";
    const button = document.createElement("button");
    button.type = "button";
    const statusText = saved.over ? `${saved.won ? "solved" : "missed"} · view` : "play";
    button.innerHTML = `<span>${escapeHtml(dateLabel)} · #${String(info.puzzleNo).padStart(4, "0")}</span><span class="archive-status">${statusText}</span>`;
    button.addEventListener("click", () => { closeModals(); loadPuzzle(entry.date); });
    item.appendChild(button);
    list.appendChild(item);
  });
}

$("#archiveButton").addEventListener("click", () => { renderArchiveList(); openModal("archiveModal"); });
$("#archiveBackButton").addEventListener("click", () => loadPuzzle(todayKey));
$("#transmissionAnswer").addEventListener("click", () => { if (state.over) reveal(); });

window.addEventListener("clipr:new-game", () => input.focus());
render();
loadQueue().then((days) => {
  queueDays = days;
  loadPuzzle(todayKey);
});
