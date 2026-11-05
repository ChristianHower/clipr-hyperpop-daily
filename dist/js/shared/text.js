// Shared text/normalization helpers used by both game modes (Endless and Legacy daily).
// Pure functions — no DOM, no network — so they are trivially shared and testable.

// Lowercase and strip everything but [a-z0-9] for loose matching of titles/artists.
// Guards null/undefined (a non-string input normalizes to "").
export function normalize(value) {
  return (value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Human label for a track in the suggestion list and guess comparison.
export function label(track) {
  return `${track.artist} — ${track.title}`;
}

// "1 second" / "2 seconds".
export function formatDuration(seconds) {
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

// Distinct numeric Deezer artist ids from a Deezer track record (main artist + contributors).
export function artistIds(record) {
  return [...new Set(
    [record.artist?.id, ...(record.contributors || []).map((artist) => artist.id)]
      .map(Number)
      .filter(Number.isFinite)
  )];
}

// Distinct normalized artist name keys from a Deezer track record, plus an optional fallback.
export function artistKeys(record, fallbackArtist = "") {
  return [...new Set(
    [record.artist?.name, ...(record.contributors || []).map((artist) => artist.name), fallbackArtist]
      .map((name) => normalize(name || ""))
      .filter(Boolean)
  )];
}

// True when the two key lists intersect (shared artist / album between guess and answer).
export function sharesValue(left, right) {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}
