// Deezer JSONP fetch, shared by both modes. Deezer's public API omits CORS headers, so the
// browser cannot read a normal fetch() — JSONP (a <script> tag with a callback) is the keyless
// way around that. Legacy uses it for track metadata + artwork; Endless uses it for reveal
// artwork only. Rate limiting (the Endless limiter) wraps this at the call site, not here.
export function deezerJsonp(path) {
  return new Promise((resolve, reject) => {
    const callback = `cliprDeezer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const cleanup = () => { delete window[callback]; script.remove(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Deezer request timed out")); }, 10000);
    window[callback] = (data) => {
      clearTimeout(timer);
      cleanup();
      if (data?.error) reject(new Error(data.error.message || "Deezer request failed"));
      else resolve(data);
    };
    script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error("Deezer is unavailable")); };
    const joiner = path.includes("?") ? "&" : "?";
    script.src = `https://api.deezer.com${path}${joiner}output=jsonp&callback=${callback}`;
    document.head.appendChild(script);
  });
}
