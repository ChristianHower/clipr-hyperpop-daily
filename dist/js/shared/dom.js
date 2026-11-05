// Shared DOM utilities used by both game modes: element lookup, HTML escaping, the toast,
// and modal open/close wiring.

// querySelector shorthand.
export const $ = (selector) => document.querySelector(selector);

// Escape arbitrary text for safe interpolation into innerHTML. Uses the browser's own text
// serialization (setting textContent, reading innerHTML), so it can never introduce markup.
export function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

// Transient status toast. Shares a single timer so rapid messages don't stack.
export function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
}

// Open a modal by id and move focus to its first button (dialog accessibility).
export function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add("open");
  modal.querySelector("button").focus();
}

// Close every open modal.
export function closeModals() {
  document.querySelectorAll(".modal.open").forEach((m) => m.classList.remove("open"));
}

// Wire the standard modal dismissal affordances once: [data-close] buttons, backdrop
// mousedown, and the Escape key. Both pages use the identical behaviour.
export function wireModalDismissal() {
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModals));
  document.querySelectorAll(".modal").forEach((modal) =>
    modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeModals(); })
  );
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModals(); });
}
