import { useEffect, useState, type MouseEvent } from "react";

/**
 * A very small history router. Every page in the portal has an address, so the
 * browser's back and forward buttons work, a page can be bookmarked or sent
 * around as a link, and a reload lands where it started.
 *
 *   /                    group sign-in (/?code=XXXX signs that group in)
 *   /admin               staff sign-in
 *   /current             Current Medical Plan(s)
 *   /options             2027 Medical Plan Options
 *   /admin/groups        Rate Administration — Groups
 *   /admin/groups/:name  one company's page
 *   /admin/rates         Rate Administration — Existing Plans & Rates
 *   /admin/proposals     Rate Administration — Proposals
 *   /admin/import        Rate Administration — Import
 *
 * Sections within a page are plain `#hash` anchors.
 */
export interface Route {
  path: string;
  hash: string;
}

export type Page =
  | { kind: "signin"; staff: boolean }
  | { kind: "group"; tab: "current" | "options" }
  | { kind: "admin"; tab: "groups" | "rates" | "proposals" | "import"; group: string | null }
  | { kind: "unknown" };

export const PATHS = {
  signin: "/",
  staffSignin: "/admin",
  current: "/current",
  options: "/options",
  groups: "/admin/groups",
  rates: "/admin/rates",
  proposals: "/admin/proposals",
  import: "/admin/import",
} as const;

export const groupPath = (name: string) => `${PATHS.groups}/${encodeURIComponent(name)}`;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parsePath(path: string): Page {
  if (path === PATHS.signin) return { kind: "signin", staff: false };
  if (path === PATHS.staffSignin) return { kind: "signin", staff: true };
  if (path === PATHS.current) return { kind: "group", tab: "current" };
  if (path === PATHS.options) return { kind: "group", tab: "options" };
  const m = path.match(/^\/admin\/(groups|rates|proposals|import)(?:\/(.+))?$/);
  if (m) {
    const tab = m[1] as "groups" | "rates" | "proposals" | "import";
    return { kind: "admin", tab, group: tab === "groups" && m[2] ? safeDecode(m[2]) : null };
  }
  return { kind: "unknown" };
}

function read(): Route {
  return {
    path: window.location.pathname.replace(/\/+$/, "") || "/",
    hash: window.location.hash.replace(/^#/, ""),
  };
}

export const currentPage = (): Page => parsePath(read().path);

const listeners = new Set<() => void>();

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const here = window.location.pathname + window.location.search + window.location.hash;
  if (here === to) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  listeners.forEach((l) => l());
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    listeners.add(on);
    window.addEventListener("popstate", on);
    window.addEventListener("hashchange", on);
    return () => {
      listeners.delete(on);
      window.removeEventListener("popstate", on);
      window.removeEventListener("hashchange", on);
    };
  }, []);
  return route;
}

/**
 * Intercept a plain left click on an in-app link and route it through history
 * instead of reloading. Modified clicks (new tab, etc.) are left to the browser.
 */
export function handleLinkClick(e: MouseEvent<HTMLAnchorElement>, href: string, replace?: boolean) {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const target = e.currentTarget.target;
  if (target && target !== "_self") return;
  e.preventDefault();
  navigate(href, { replace });
}
