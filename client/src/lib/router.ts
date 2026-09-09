import { useEffect, useState, type MouseEvent } from "react";

/**
 * A very small history router. Every page in the portal has an address, so the
 * browser's back and forward buttons work, a page can be bookmarked or sent
 * around as a link, and a reload lands where it started.
 *
 *   /                    group sign-in (/?code=XXXX signs that group in)
 *   /g/:slug/:token             a group's own permanent address — Welcome
 *   /g/:slug/:token/changes     …What's Changing For 2027
 *   /g/:slug/:token/current     …Your 2026 Plan
 *   /g/:slug/:token/options     …Your 2027 Options
 *   /g/:slug/:token/supplemental …Supplemental Package
 *   /g/:slug/:token/signup      …Sign Up
 *   /admin               staff sign-in
 *   /current             Current 2026 Medical Plans
 *   /options             New 2027 Medical Plans
 *   /admin/groups        Rate Administration — Groups
 *   /admin/groups/:name  one company's page
 *   /admin/rates         Rate Administration — Existing Plans & Rates
 *   /admin/proposals     Rate Administration — Proposals
 *   /admin/import        Rate Administration — Import
 *
 * The slug in a group address is the company and its plan-year code — say
 * `johnson-storage-moving-jsmh2027` — so a link a client bookmarks or forwards
 * says whose page it opens. The token beside it is the credential; the slug is
 * cosmetic and any spelling of it is accepted, then rewritten to the canonical
 * one. Addresses minted before the slug existed (`/g/:token`) still work.
 *
 * Sections within a page are plain `#hash` anchors.
 */
export interface Route {
  path: string;
  hash: string;
}

/** The pages a signed-in group has, in the order the side navigation lists them. */
export type GroupTab = "home" | "changes" | "current" | "options" | "supplemental" | "signup";

export type Page =
  | { kind: "signin"; staff: boolean }
  | { kind: "group"; tab: GroupTab; token?: string; slug?: string }
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

/**
 * The readable half of a group's address: the company name and its plan-year
 * code, e.g. "Johnson Storage & Moving Co. Holdings, LLC" + "JSMH2027" ->
 * `johnson-storage-moving-jsmh2027`. Nothing is looked up by it, so a rename
 * only changes what the address reads like, never who it opens.
 */
export function groupSlug(name: string, code?: string | null): string {
  const words = String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !SKIP_WORDS.has(w));
  const stem = words.slice(0, 5).join("-").slice(0, 60).replace(/-+$/, "");
  const tail = String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return [stem, tail].filter(Boolean).join("-") || "group";
}

/** Legal forms and filler, which say nothing about which company a link opens. */
const SKIP_WORDS = new Set([
  "llc", "lc", "inc", "incorporated", "corp", "corporation", "co", "company",
  "companies", "ltd", "limited", "lp", "llp", "pc", "pllc", "plc", "pa",
  "the", "of", "and", "a", "an",
]);

/**
 * A group's own address. With a name and code it carries the readable slug;
 * without them it falls back to the bare token, which is still accepted.
 */
export const linkPath = (
  token: string,
  tab: GroupTab = "home",
  group?: { name?: string; code?: string | null } | null,
) => {
  const head = group && group.name
    ? `/g/${groupSlug(group.name, group.code)}/${encodeURIComponent(token)}`
    : `/g/${encodeURIComponent(token)}`;
  return tab === "home" ? head : `${head}/${tab}`;
};

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
  // A group's permanent address: the token stays in the bar, so the page can
  // be bookmarked and shared without a code being typed.
  const s = path.match(/^\/g\/([a-z0-9][a-z0-9-]{0,79})\/([A-Za-z0-9_-]{8,64})(?:\/(changes|current|options|supplemental|signup))?$/);
  if (s) return { kind: "group", tab: (s[3] as GroupTab) || "home", token: s[2], slug: s[1] };
  // Addresses minted before the slug: the token alone. The base address is the
  // home page now, so an old bookmark lands there and is rewritten to the
  // readable spelling; nothing it used to reach has moved further than a click.
  const t = path.match(/^\/g\/([A-Za-z0-9_-]{8,64})(?:\/(changes|current|options|supplemental|signup))?$/);
  if (t) return { kind: "group", tab: (t[2] as GroupTab) || "home", token: t[1] };
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
