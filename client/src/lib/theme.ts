/**
 * Light or dark, for the whole site. Two states, no "system" toggle to
 * explain — a browser's own dark-mode setting picks the default the first
 * time, and the explicit choice sticks after that, in this browser only.
 */
export type Theme = "light" | "dark";

const KEY = "kennion.theme";

function systemPrefers(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** What this browser last chose, or the system default if it never chose. */
export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Storage blocked: fall through to the system default.
  }
  return systemPrefers();
}

/** Paint the theme onto the document. Safe to call before React mounts. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the choice still applies for this page load.
  }
}
