/**
 * The signed-in session, kept in sessionStorage so a reload or a pasted link
 * lands on the page asked for instead of back at sign-in. sessionStorage is
 * scoped to the tab and cleared when it closes; nothing is written to disk
 * beyond that, and no census data is stored - only what is needed to sign in
 * again (the group's own code, or the staff bearer token).
 */
const KEY = "kennion.session";

export type StoredSession = { kind: "group"; code: string } | { kind: "admin"; token: string };

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.kind === "group" && typeof s.code === "string") return s;
    if (s && s.kind === "admin" && typeof s.token === "string") return s;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage blocked (private mode, quota): the session still works for this
    // page load, it just will not survive a reload.
  }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * The group this tab's page is showing, named on every request the page
 * makes so the server answers for it and not for whichever group signed in
 * last in another tab (the session cookie is one per browser). Set when a
 * group's payload is applied; cleared on sign-out.
 */
let pageGroup: { token: string | null; code: string | null } = { token: null, code: null };

export function setPageGroup(g: { token?: string | null; code?: string | null } | null) {
  pageGroup = g ? { token: g.token || null, code: g.code || null } : { token: null, code: null };
}

/** Headers naming the page's group; empty when no group is signed in. */
export function groupHeaders(): Record<string, string> {
  if (pageGroup.token) return { "X-Kennion-Group-Token": pageGroup.token };
  if (pageGroup.code) return { "X-Kennion-Group-Code": pageGroup.code };
  return {};
}
