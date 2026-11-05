// Shared clip-ladder constants and the preview playback engine used by both modes.
//
// Players start with 0.5s of audio; each miss/skip unlocks a longer clip up the ladder, and the
// full 30s preview unlocks once the round ends.
export const clipSteps = [0.5, 1, 2, 4, 8, 16];
export const maxAttempts = clipSteps.length;
export const previewDuration = 30;

// Create the preview player. Both pages had a byte-identical stop/play pair differing only in two
// toast strings, so this factory takes those messages and the shared pieces of state the engine
// touches, and returns { stopPreview, playSignal, isPlaying }.
//
// `ctx` provides:
//   els:    { playButton, resultPlayButton, playbackFill, playhead }
//   audio:  () => the current HTMLAudioElement (or null) for the active round
//   isOver: () => boolean — whether the round is over (full 30s timeline vs clip ladder)
//   ready:  () => boolean — whether a preview is loaded and playable
//   toast:  (msg) => void
//   messages: { loading, blocked }
export function createPreviewPlayer(ctx) {
  const { els, audio, isOver, ready, toast, messages } = ctx;
  let playbackRun = 0;
  let previewTimer = null;
  let playing = false;

  function stopPreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    playbackRun += 1;
    const el = audio();
    if (el) { el.pause(); el.currentTime = 0; }
    playing = false;
    els.playButton.textContent = "▶";
    els.resultPlayButton.textContent = "play 30 sec";
    els.playbackFill.style.width = "0";
    els.playhead.style.left = "0";
  }

  async function playSignal() {
    const el = audio();
    if (!ready() || !el) return toast(messages.loading);
    if (playing) return stopPreview();
    const duration = isOver() ? previewDuration : clipSteps[Math.min(currentStepFromCtx(), clipSteps.length - 1)];
    stopPreview();
    const run = ++playbackRun;
    try {
      await el.play();
      playing = true;
      els.playButton.textContent = "■";
      els.resultPlayButton.textContent = "stop preview";
      const started = performance.now();
      const timelineDuration = isOver() ? previewDuration : clipSteps[clipSteps.length - 1];
      const animate = (time) => {
        if (!playing || run !== playbackRun) return;
        const elapsed = Math.min(duration, (time - started) / 1000);
        const width = Math.min(100, (elapsed / timelineDuration) * 100);
        els.playbackFill.style.width = `${width}%`;
        els.playhead.style.left = `${width}%`;
        if (elapsed < duration) requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
      previewTimer = setTimeout(stopPreview, duration * 1000);
    } catch (_) {
      stopPreview();
      toast(messages.blocked);
    }
  }

  // The current clip duration depends on how many attempts have been made; the page supplies
  // that via ctx.currentStep so the engine stays mode-agnostic.
  function currentStepFromCtx() { return ctx.currentStep(); }

  return { stopPreview, playSignal, isPlaying: () => playing };
}
