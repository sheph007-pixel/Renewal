import { useEffect, useState, type MouseEvent } from "react";

/**
 * A very small history router. Every page in the portal has an address, so the
 * browser's back and forward buttons work, a page can be bookmarked or sent
 * around as a link, and a reload lands where it started.
 *
 *   /                    group sign-in (/?code=XXXX signs that group in)
 *   /login               …the same page, for a link that assumes this address
 *   /:slug               a signed-in group's own pages - Welcome
 *   /:slug/assistant     …Assistant (and /:slug/assistant/:id, one conversation)
 *   /:slug/changes       …an old address: What's Changing is a section of Welcome now
 *   /:slug/changes       …What's New for 2027
 *   /:slug/current       …Your 2026 Medical Plans
 *   /:slug/options       …New 2027 Medical Options
 *   /:slug/supplemental  …Supplemental Package
 *   /:slug/resources     …Resources (vendor marketing material, one page for every group)
 *   /:slug/disclaimers   …Disclaimers (the full text behind every "View Disclaimers" link)
 *   /:slug/census        …Census (who is enrolled: the link behind every "N enrolled")
 *   /:slug/signup        …Sign Up
 *   /g/:slug/:token      a group's permanent link: signs the browser in and
 *                        lands on /:slug (a tab after the token is kept)
 *   /admin               staff sign-in
 *   /current             Your 2026 Medical Plans
 *   /options             New 2027 Medical Options
 *   /admin/groups        Rate Administration - Groups
 *   /admin/groups/:name  one company's page
 *   /admin/rates         Rate Administration - Existing Plans & Rates
 *   /admin/proposals     Rate Administration - Proposals
 *   /admin/import        Rate Administration - Import
 *   /admin/assistant     Rate Administration - Assistant (conversations, playbook)
 *   /admin/data          Rate Administration - Data Check (every group's figures, checked)
 *   /admin/resources     Rate Administration - Resources (upload vendor marketing material)
 *   /admin/welcome       Rate Administration - Welcome Page (the copy every group reads, by status)
 *
 * The slug in a group address is the company and its plan-year code - say
 * `johnson-storage-moving-jsmh2027` - so the address says whose page it is.
 * The session itself is a cookie the server sets at sign-in, so nothing
 * secret rides in the bar: a group's everyday address is just `/:slug/:tab`.
 * The permanent link, `/g/:slug/:token`, is the credential a client is sent;
 * opening it signs the browser in and the bar is rewritten to the short form.
 * Addresses minted before the slug existed (`/g/:token`) still work.
 *
 * Sections within a page are plain `#hash` anchors.
 */
export interface Route {
  path: string;
  hash: string;
}

/** The pages a signed-in group has, in the order the side navigation lists them. */
export type GroupTab = "home" | "assistant" | "current" | "options" | "supplemental" | "resources" | "signup" | "disclaimers" | "census";

export type Page =
  | { kind: "signin"; staff: boolean }
  | { kind: "group"; tab: GroupTab; token?: string; slug?: string; code?: string; thread?: number }
  | { kind: "admin"; tab: "groups" | "rates" | "proposals" | "import" | "assistant" | "data" | "resources" | "welcome"; group: string | null }
  | { kind: "unknown" };

export const PATHS = {
  signin: "/",
  /** An alias for the same sign-in page - some link or bookmark elsewhere assumes this address exists. */
  login: "/login",
  staffSignin: "/admin",
  current: "/current",
  options: "/options",
  groups: "/admin/groups",
  rates: "/admin/rates",
  proposals: "/admin/proposals",
  import: "/admin/import",
  assistantAdmin: "/admin/assistant",
  data: "/admin/data",
  resourcesAdmin: "/admin/resources",
  welcomeAdmin: "/admin/welcome",
} as const;

export const groupPath = (name: string) => `${PATHS.groups}/${encodeURIComponent(name)}`;

/** First path segments that are pages of their own, never a group's slug. */
const RESERVED = new Set(["g", "admin", "api", "assets", "current", "options", "healthz", "login"]);
const TABS = "assistant|changes|current|options|supplemental|resources|signup|disclaimers|census";
/** The Assistant page may name one conversation: `/:slug/assistant/:id`. */
const TAB_TAIL = `(?:\\/(${TABS})(?:\\/(\\d{1,12}))?)?`;

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

/** A signed-in group's address via short code: /ADOB61, optionally with a tab. */
export const groupHomeByCode = (code: string, tab: GroupTab = "home", thread?: number | null) => {
  const head = `/${code.toUpperCase()}`;
  if (tab === "home") return head;
  return tab === "assistant" && thread ? `${head}/${tab}/${thread}` : `${head}/${tab}`;
};

/** A signed-in group's short address: its slug, then the tab. */
export const groupHome = (group: { name?: string; code?: string | null }, tab: GroupTab = "home", thread?: number | null) => {
  const head = `/${groupSlug(group.name || "", group.code)}`;
  if (tab === "home") return head;
  return tab === "assistant" && thread ? `${head}/${tab}/${thread}` : `${head}/${tab}`;
};

/**
 * A group's permanent link - the one a client is sent. With a name and code
 * it carries the readable slug; without them it falls back to the bare token,
 * which is still accepted.
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
  if (path === PATHS.signin || path === PATHS.login) return { kind: "signin", staff: false };
  if (path === PATHS.staffSignin) return { kind: "signin", staff: true };
  if (path === PATHS.current) return { kind: "group", tab: "current" };
  if (path === PATHS.options) return { kind: "group", tab: "options" };
  // A group's permanent address: the token stays in the bar, so the page can
  // be bookmarked and shared without a code being typed.
  const thread = (raw: string | undefined) => (raw ? Number(raw) : undefined);
  // What's Changing is a section of Welcome now; an old link to its page lands there.
  const tabOf = (raw: string | undefined): GroupTab => (raw === "changes" || !raw ? "home" : (raw as GroupTab));
  const s = path.match(new RegExp(`^\\/g\\/([a-z0-9][a-z0-9-]{0,79})\\/([A-Za-z0-9_-]{8,64})${TAB_TAIL}$`));
  if (s) return { kind: "group", tab: tabOf(s[3]), token: s[2], slug: s[1], thread: thread(s[4]) };
  // Addresses minted before the slug: the token alone. The base address is the
  // home page now, so an old bookmark lands there and is rewritten to the
  // readable spelling; nothing it used to reach has moved further than a click.
  const t = path.match(new RegExp(`^\\/g\\/([A-Za-z0-9_-]{8,64})${TAB_TAIL}$`));
  if (t) return { kind: "group", tab: tabOf(t[2]), token: t[1], thread: thread(t[3]) };
  // Short-code sign-in: four letters and two digits (e.g., /ADOB61), optionally with a tab.
  // The code is the sign-in credential; the session is a cookie set by the server.
  const shortCode = path.match(new RegExp(`^\\/([A-Z]{4}\\d{2})${TAB_TAIL}$`));
  if (shortCode) return { kind: "group", tab: tabOf(shortCode[2]), code: shortCode[1], thread: thread(shortCode[3]) };
  // The short address: the slug alone, the session being a cookie.
  const g = path.match(new RegExp(`^\\/([a-z0-9][a-z0-9-]{1,79})${TAB_TAIL}$`));
  if (g && !RESERVED.has(g[1])) return { kind: "group", tab: tabOf(g[2]), slug: g[1], thread: thread(g[3]) };
  const m = path.match(/^\/admin\/(groups|rates|proposals|import|assistant|data|resources|welcome)(?:\/(.+))?$/);
  if (m) {
    const tab = m[1] as "groups" | "rates" | "proposals" | "import" | "assistant" | "data" | "resources" | "welcome";
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
