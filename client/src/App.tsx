import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  contributionByTier,
  ovKey,
  planRows,
  type KennionData,
  type Overrides,
  type TierKey,
} from "@/lib/model";
import { C, Logo, panel } from "@/lib/ui";
import {
  PATHS,
  currentPage,
  groupHome,
  navigate,
  parsePath,
  useRoute,
  type GroupTab,
} from "@/lib/router";
import Link from "@/lib/Link";
import { clearSession, loadSession, saveSession } from "@/lib/session";
import Login from "@/views/Login";
import Footer from "@/views/Footer";
import Admin, { type ImportRecord } from "@/views/Admin";
import type { CarrierStats } from "@/views/Reconciliation";
import type { FundingInfo } from "@/views/Funding";
import Current from "@/views/Current";
import Options from "@/views/Options";
import Home from "@/views/Home";
import WhatsChanging from "@/views/WhatsChanging";
import SupplementalPackage from "@/views/SupplementalPackage";
import SignUp from "@/views/SignUp";
import SideNav, { RAIL_OPEN, RAIL_SHUT, type NavItem } from "@/views/SideNav";
import HrAnalytics from "@/views/HrAnalytics";
import type { AccountManager } from "@/lib/model";

/**
 * Placeholder employer-contribution percentages, used only for groups whose
 * Employee Navigator export has not been loaded. Where EN data exists the real
 * split is used and these are ignored entirely.
 */
const EE_PCT = 80;
const DEP_PCT = 32;

const SITE = "Kennion 2027 Renewal";

/** Every client page's name, said the same way everywhere it appears. */
const TAB_LABEL: Record<GroupTab, string> = {
  home: "Welcome",
  changes: "What's Changing For 2027",
  current: "Your 2026 Medical Plans",
  options: "New 2027 Medical Options",
  supplemental: "Supplemental Package",
  signup: "Sign Up",
};

/** Where the collapsed/expanded rail is remembered. */
const NAV_KEY = "kennion.nav.collapsed";

/** Below this the rail stops being a column, so collapsing it means nothing. */
const RAIL_WIDTH = "(max-width: 860px)";

/** True while the viewport is too narrow for a side rail. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(RAIL_WIDTH).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(RAIL_WIDTH);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/**
 * The access code carried in the address, if any: `/?code=ABCD2027` signs that
 * group in. It is what a client is sent, and what staff open to see exactly
 * what the client sees.
 */
function linkCodeAtLoad(): string | null {
  if (typeof window === "undefined") return null;
  const c = new URLSearchParams(window.location.search).get("code");
  return c && c.trim() ? c.trim().toUpperCase() : null;
}

export default function App() {
  const route = useRoute();
  const page = useMemo(() => parsePath(route.path), [route.path]);

  const [data, setData] = useState<KennionData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  // True while a session saved in this tab is being re-established, so a
  // reload does not flash the sign-in screen on its way back to the page.
  const linkCode = useMemo(linkCodeAtLoad, []);
  /** Who at Kennion holds this group, for the contact card and the rail. */
  const [manager, setManager] = useState<AccountManager | null>(null);
  /** The rail, collapsed or not. Remembered per browser, so it stays that way. */
  const narrow = useNarrow();
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_KEY) === "1";
    } catch {
      return false;
    }
  });
  // Always true at first: even a bare "/" may hold a session cookie, and the
  // server is asked before the sign-in form is shown.
  const [restoring, setRestoring] = useState(true);
  const restoreStarted = useRef(false);
  const [code, setCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState(false);
  /** Set when the staff code was right and the second factor is owed. */
  const [pending2fa, setPending2fa] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [email, setEmail] = useState("");
  const [staffCode, setStaffCode] = useState("");
  const [staffError, setStaffError] = useState(false);
  const [token, setToken] = useState("");
  const tokenRef = useRef("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [storage, setStorage] = useState("");
  const [imports, setImports] = useState<ImportRecord[]>([]);
  const [carrierStats, setCarrierStats] = useState<CarrierStats | null>(null);
  const [funding, setFunding] = useState<FundingInfo | null>(null);
  const [ai, setAi] = useState(false);
  const [durable, setDurable] = useState(false);

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupError, setSignupError] = useState("");

  const [admin, setAdmin] = useState(false);
  const [adminQuery, setAdminQuery] = useState("");
  const [adminTpa, setAdminTpa] = useState("All");
  const [gapsOnly, setGapsOnly] = useState(false);
  const [overrides, setOverrides] = useState<Overrides>({});

  /** Load a staff payload into state. `tok` is the bearer token to keep using. */
  const applyAdmin = useCallback((p: Record<string, unknown>, tok: string) => {
    setToken(tok);
    tokenRef.current = tok;
    setDurable(!!p.durable);
    setStorage((p.storage as string) || "");
    setOverrides((p.overrides as Overrides) || {});
    setImports((p.imports as ImportRecord[]) || []);
    setCarrierStats((p.carrierStats as CarrierStats | null) || null);
    setFunding((p.funding as FundingInfo | null) || null);
    setAi(!!p.ai);
    setData({
      meta: p.meta,
      groups: p.groups,
      planDesigns: p.planDesigns,
      uhc: { detail: {}, summary: {}, menu: [], mapping: [] },
      splits: {},
    } as KennionData);
    setAdmin(true);
    saveSession({ kind: "admin", token: tok });
  }, []);

  /** Load one group's payload into state. */
  const applyGroup = useCallback((p: Record<string, unknown>) => {
    const group = p.group as KennionData["groups"][number];
    setOverrides((p.overrides as Overrides) || {});
    setData({
      meta: p.meta,
      groups: [group],
      planDesigns: p.planDesigns,
      uhc: p.uhc,
      splits: p.splits,
      proposals: p.proposals || [],
      slots: p.slots || undefined,
      funding: p.funding || null,
      invoice: p.invoice || null,
    } as KennionData);
    setCode(group.code);
    setManager((p.accountManager as AccountManager) || null);
    saveSession({ kind: "group", code: group.code });
  }, []);

  /**
   * Sign in against the server. The census is not public, so a code buys
   * exactly one group's data (or, for the admin code, a PII-free rate table).
   * On success the browser is sent to the page it asked for, if that page
   * belongs to this kind of session, and otherwise to that session's home.
   */
  const signIn = useCallback(
    async (payload: { code: string; email?: string }) => {
      const staff = payload.email != null;
      if (!payload.code.trim() && !staff) return;
      setBusy(true);
      setCodeError(false);
      setStaffError(false);
      try {
        const r = await fetch("/api/signin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          if (staff) setStaffError(true);
          else setCodeError(true);
          return;
        }
        const p = await r.json();
        const asked = currentPage();
        if (p.kind === "staff-2fa") {
          // The code was right; the authenticator still has to agree.
          setPending2fa(p.pending as string);
          setTotpCode("");
          return;
        }
        if (p.kind === "admin") {
          applyAdmin(p, p.token || "");
          if (asked.kind !== "admin") navigate(PATHS.groups, { replace: true });
        } else {
          applyGroup(p);
          // Signed in at one of this group's own addresses: stay there (the
          // bar is rewritten to the short form). Anywhere else: its home.
          const own = asked.kind === "group" && (asked.token === p.linkToken || asked.slug === p.slug);
          if (!own) navigate(groupHome(p.group), { replace: true });
        }
      } catch {
        setLoadError(true);
      } finally {
        setBusy(false);
      }
    },
    [applyAdmin, applyGroup],
  );

  /** The second factor: six digits from the authenticator, or a recovery code. */
  const submitTotp = useCallback(async () => {
    if (!pending2fa || !totpCode.trim()) return;
    setBusy(true);
    setStaffError(false);
    try {
      const r = await fetch("/api/signin/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pending: pending2fa, code: totpCode.trim() }),
      });
      if (!r.ok) {
        setStaffError(true);
        // An expired or spent ticket means starting the sign-in over.
        if (r.status === 401 && (await r.json().catch(() => ({}))).error?.includes("expired")) {
          setPending2fa(null);
        }
        return;
      }
      const p = await r.json();
      setPending2fa(null);
      setTotpCode("");
      applyAdmin(p, p.token || "");
      if (currentPage().kind !== "admin") navigate(PATHS.groups, { replace: true });
    } catch {
      setLoadError(true);
    } finally {
      setBusy(false);
    }
  }, [applyAdmin, pending2fa, totpCode]);

  /**
   * Re-establish the session this tab already had. A group's code is simply
   * signed in again; a staff token is checked against the server, which still
   * holds it unless it expired or the server restarted.
   */
  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    // A group's own address, /g/<token>: sign in with the token and stay
    // where we are, so the address can be bookmarked and shared.
    const asked = currentPage();
    const tokenInPath = asked.kind === "group" ? asked.token : undefined;
    if (tokenInPath) {
      (async () => {
        try {
          const r = await fetch("/api/signin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenInPath }),
          });
          if (!r.ok) {
            clearSession();
            navigate(PATHS.signin, { replace: true });
            return;
          }
          applyGroup(await r.json());
        } catch {
          setLoadError(true);
        } finally {
          setRestoring(false);
        }
      })();
      return;
    }

    // A code in the address wins over whatever this tab had: it is a
    // deliberate "show me this group". The code is taken out of the address
    // once it is used, so it does not sit in the bar, the history or a
    // screenshot — the group's own /g/<token> address is the one to keep.
    if (linkCode) {
      (async () => {
        try {
          const r = await fetch("/api/signin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: linkCode }),
          });
          if (!r.ok) {
            clearSession();
            setCodeError(true);
            navigate(PATHS.signin, { replace: true });
            return;
          }
          const p = await r.json();
          applyGroup(p);
          navigate(groupHome(p.group), { replace: true });
        } catch {
          setLoadError(true);
        } finally {
          setRestoring(false);
        }
      })();
      return;
    }

    // Otherwise the session this tab saved, or — with nothing saved — the
    // cookie the server set the last time this browser signed in as a group.
    // A cookie for one group at another group's short address does not sign
    // anyone in: the address wins, and that group's code is asked for.
    const s = loadSession();
    (async () => {
      try {
        if (!s || s.kind === "group") {
          const r = await fetch("/api/signin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(s ? { code: s.code } : {}),
          });
          if (!r.ok) throw new Error("expired");
          const p = await r.json();
          if (asked.kind === "group" && asked.slug && !asked.token && p.slug && asked.slug !== p.slug) {
            throw new Error("another group's address");
          }
          applyGroup(p);
        } else {
          const r = await fetch("/api/admin/session", {
            headers: { Authorization: `Bearer ${s.token}` },
          });
          if (!r.ok) throw new Error("expired");
          applyAdmin(await r.json(), s.token);
        }
      } catch {
        clearSession();
      } finally {
        setRestoring(false);
      }
    })();
  }, [applyAdmin, applyGroup, linkCode]);

  /**
   * Hand-keyed rates are saved on the server, so they are shared with everyone
   * at Kennion rather than living in whichever browser typed them. The field
   * updates immediately and the write follows; a failed write is surfaced
   * rather than silently dropped.
   */
  const setOverride = useCallback(
    (group: string, plan: string, census: string, raw: string) => {
      const k = ovKey(group, plan, census);
      setOverrides((prev) => {
        const next = { ...prev };
        if (raw.trim() === "") delete next[k];
        else next[k] = raw;
        return next;
      });
      setSaveState("saving");
      void fetch("/api/admin/override", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenRef.current}`, "Content-Type": "application/json" },
        body: JSON.stringify({ group, plan, censusTier: census, rate: raw.trim() }),
      })
        .then((r) => setSaveState(r.ok ? "saved" : "error"))
        .catch(() => setSaveState("error"));
    },
    [],
  );

  const g = useMemo(
    () => (data && code ? data.groups.find((x) => x.code === code) || null : null),
    [data, code],
  );

  const rows = useMemo(
    () => (data && g ? planRows(data, overrides, g, EE_PCT, DEP_PCT) : []),
    [data, overrides, g],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, r) => ({
          er: a.er + r.er,
          ee: a.ee + r.ee,
          total: a.total + r.total,
          enrolled: a.enrolled + (r.p.enrolled || 0),
        }),
        { er: 0, ee: 0, total: 0, enrolled: 0 },
      ),
    [rows],
  );

  /**
   * What the group puts toward each tier today, read off its own rates and
   * enrollment — the number New 2027 Medical Options starts an employer's own
   * contribution choice from, rather than from zero.
   */
  const contribution = useMemo(
    () => (data && g ? contributionByTier(data, overrides, g, EE_PCT, DEP_PCT) : []),
    [data, overrides, g],
  );

  /**
   * The employer's own choice for 2027, per tier. Null until they touch a
   * field, at which point it starts as an exact copy of today's numbers —
   * keeping spend flat is the default, changing it is a deliberate edit.
   */
  const [contributionOverride, setContributionOverride] = useState<Partial<Record<TierKey, number>> | null>(null);
  const contributionValues: Record<TierKey, number> = useMemo(() => {
    const base = {} as Record<TierKey, number>;
    contribution.forEach((t) => {
      base[t.key] = t.er ?? 0;
    });
    return { ...base, ...(contributionOverride || {}) };
  }, [contribution, contributionOverride]);

  const session: "none" | "group" | "admin" = admin ? "admin" : g ? "group" : "none";

  /**
   * Keep the address and the session consistent. A group at an admin address
   * (or the other way round) goes to its own home; an address that is not a
   * page at all goes to sign-in. `replace` so the back button is not trapped.
   */
  useEffect(() => {
    if (restoring) return;
    if (session === "admin" && page.kind !== "admin") navigate(PATHS.groups, { replace: true });
    else if (session === "group" && page.kind !== "group") navigate(groupHome(g!), { replace: true });
    else if (session === "none" && page.kind === "unknown") navigate(PATHS.signin, { replace: true });
  }, [restoring, session, page.kind, g]);

  /**
   * Rewrite a group address to its short, canonical form — the company and
   * its plan-year code, then the tab — once the group is known. A permanent
   * link (`/g/…/<token>`) that signed the browser in, one minted before the
   * slug existed, or a slug whose company has since been renamed all open;
   * the bar just ends up reading the current way, with no token in it.
   */
  useEffect(() => {
    if (restoring || session !== "group" || !g) return;
    if (page.kind !== "group") return;
    const want = groupHome(g, page.tab);
    if (route.path !== want) navigate(want + (route.hash ? `#${route.hash}` : ""), { replace: true });
  }, [restoring, session, g, page, route.path, route.hash]);

  /** Scroll: to the named section when there is a hash, else to the top. */
  useEffect(() => {
    if (restoring) return;
    if (route.hash) {
      const id = route.hash;
      const raf = requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: "start" });
      });
      return () => cancelAnimationFrame(raf);
    }
    window.scrollTo(0, 0);
  }, [restoring, route.path, route.hash, session]);

  /** A title per page, so tabs and history entries can be told apart. */
  useEffect(() => {
    let t = SITE;
    if (page.kind === "signin") t = `${page.staff ? "Staff sign in" : "Sign in"} — ${SITE}`;
    else if (page.kind === "group" && g) t = `${TAB_LABEL[page.tab]} — ${g.name}`;
    else if (page.kind === "admin")
      t = `${
        page.group
          ? page.group
          : page.tab === "groups"
            ? "Groups"
            : page.tab === "rates"
              ? "Existing Plans & Rates"
              : page.tab === "proposals"
                ? "Proposals"
                : "Import"
      } — Rate Administration`;
    document.title = t;
  }, [page, g]);

  const submit = () => void signIn({ code: codeInput });
  const staffSubmit = () => void signIn({ email, code: staffCode });

  const signOut = () => {
    clearSession();
    // The group session cookie is the server's to clear.
    void fetch("/api/signout", { method: "POST" }).catch(() => undefined);
    setData(null);
    setEmail("");
    setStaffCode("");
    setStaffError(false);
    setToken("");
    tokenRef.current = "";
    setCode(null);
    setCodeInput("");
    setAdmin(false);
    navigate(PATHS.signin);
  };

  const toggleSelected = (plan: string) => {
    setSelected((prev) => ({ ...prev, [plan]: !prev[plan] }));
    setSent(false);
  };

  /**
   * Send the shortlist and note to Kennion. This used to just flip a flag in
   * the browser; it now actually reaches the server, which is what makes
   * Sign Up worth its own page rather than a promise at the bottom of one.
   */
  const submitSignup = async () => {
    const plans = Object.keys(selected).filter((p) => selected[p]);
    if (!plans.length || signupBusy) return;
    setSignupBusy(true);
    setSignupError("");
    try {
      const r = await fetch("/api/group/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, plans, note: note.trim() }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "Could not send that. Try again.");
      }
      const p = await r.json();
      setSent(true);
      setData((d) =>
        d ? ({ ...d, signup: { plans, note: note.trim() || null, submittedAt: p.submittedAt } } as KennionData) : d,
      );
    } catch (e) {
      setSignupError((e as Error).message || "Could not send that. Try again.");
    } finally {
      setSignupBusy(false);
    }
  };

  if (loadError) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 20,
          textAlign: "center",
        }}
      >
        <div style={{ ...panel, padding: "26px 30px", maxWidth: 460 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>
            We couldn't load your renewal data
          </div>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            Please refresh the page. If it keeps happening, call Hunter Shepherd at 205-641-0469 or
            email <a href="mailto:hunter@kennion.com">hunter@kennion.com</a>.
          </p>
        </div>
      </div>
    );
  }

  if (restoring) {
    return (
      <div style={{ minHeight: "100vh", background: C.page }}>
        <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, padding: "0 22px" }}>
          <div
            style={{ maxWidth: 1400, margin: "0 auto", height: 56, display: "flex", alignItems: "center" }}
          >
            <img src={Logo} alt="Kennion Benefit Advisors" style={{ height: 30, display: "block" }} />
          </div>
        </div>
        <div
          role="status"
          style={{ padding: "60px 20px", textAlign: "center", fontSize: 13.5, color: C.muted }}
        >
          Signing you back in…
        </div>
      </div>
    );
  }

  // No session yet: there is nothing to load until a code is entered, because
  // the census is only handed out per-group in exchange for one. The address
  // decides which form shows — /admin, or any admin page, gets the staff form —
  // and sign-in returns to that address.
  if (!data || (!admin && !g)) {
    const staffMode = page.kind === "admin" || (page.kind === "signin" && page.staff);
    return (
      <Login
        mode={staffMode ? "staff" : "group"}
        codeInput={codeInput}
        email={email}
        staffCode={staffCode}
        codeError={codeError}
        staffError={staffError}
        busy={busy}
        onCode={(v) => {
          setCodeInput(v);
          setCodeError(false);
        }}
        onEmail={(v) => {
          setEmail(v);
          setStaffError(false);
        }}
        onStaffCode={(v) => {
          setStaffCode(v);
          setStaffError(false);
        }}
        onSubmit={submit}
        onStaffSubmit={staffSubmit}
        twoFactor={!!pending2fa}
        totpCode={totpCode}
        onTotpCode={(v) => {
          setTotpCode(v);
          setStaffError(false);
        }}
        onTotpSubmit={() => void submitTotp()}
        onCancelTwoFactor={() => {
          setPending2fa(null);
          setTotpCode("");
          setStaffError(false);
        }}
        onMode={(m) => {
          setCodeError(false);
          setStaffError(false);
          navigate(m === "staff" ? PATHS.staffSignin : PATHS.signin);
        }}
      />
    );
  }

  if (admin) {
    // The redirect effect above is about to move an admin off a non-admin
    // address; render nothing rather than a page for the wrong session.
    if (page.kind !== "admin") return null;
    return (
      <Admin
        data={data}
        token={token}
        durable={durable}
        storage={storage}
        saveState={saveState}
        imports={imports}
        carrierStats={carrierStats}
        onCarrierStats={setCarrierStats}
        funding={funding}
        onFunding={(f, gs) => {
          setFunding(f);
          if (gs) setData((d) => (d ? ({ ...d, groups: gs } as KennionData) : d));
        }}
        onOverrides={(o) => setOverrides(o as Overrides)}
        ai={ai}
        tab={page.tab}
        openGroup={page.group}
        onImported={(gs, ims) => {
          setData((d) => (d ? ({ ...d, groups: gs } as KennionData) : d));
          if (ims) setImports(ims);
        }}
        overrides={overrides}
        query={adminQuery}
        tpa={adminTpa}
        gapsOnly={gapsOnly}
        onQuery={setAdminQuery}
        onTpa={setAdminTpa}
        onToggleGaps={() => setGapsOnly((v) => !v)}
        onSetOverride={setOverride}
        onExit={signOut}
      />
    );
  }

  // Narrowing for TypeScript: a non-admin session always has a group, because
  // the guard above returns the sign-in screen otherwise.
  if (!g) return null;
  if (page.kind !== "group") return null;

  const tab = page.tab;

  /**
   * The program runs on the calendar year, so every group's page says the same
   * thing. A handful of groups carry a mid-year date because that is when they
   * joined, not because their plan year differs, and showing 04/01 there read
   * as a different plan year to anyone comparing two groups.
   */
  const planYear = (g.pyEnd || "2026-12-31").slice(0, 4);
  const subline =
    tab === "options" || tab === "signup" || tab === "changes"
      ? "Effective January 1, 2027"
      : tab === "supplemental"
        ? "What Employee Navigator has on file besides medical"
        : `Calendar Year (January 1 – December 31, ${planYear})`;

  const printLine =
    (tab === "options" || tab === "signup" || tab === "changes"
      ? "2027 renewal options, effective January 1, 2027"
      : tab === "supplemental"
        ? "Supplemental benefits on file, besides medical"
        : `Current group health plans and cost, calendar year ${planYear}`) +
    ` · data as of 7/31/2026 · printed ${new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })}`;

  // Every page lives under the group's short address.
  const hrefFor = (t: GroupTab) => (g ? groupHome(g, t) : t === "options" ? PATHS.options : PATHS.current);

  // Welcome carries no step — it is where you start, not part of the count —
  // so the five real pages run 1 through 5, Sign Up included.
  const TAB_STEP: Partial<Record<GroupTab, number>> = {
    changes: 1,
    current: 2,
    options: 3,
    supplemental: 4,
    signup: 5,
  };
  const navItems: NavItem[] = (["home", "changes", "current", "options", "supplemental", "signup"] as GroupTab[]).map(
    (t) => ({
      tab: t,
      href: hrefFor(t),
      label: TAB_LABEL[t],
      step: TAB_STEP[t],
      mark: t === "home" ? "home" : undefined,
      cta: t === "signup",
    }),
  );

  const here = navItems.findIndex((it) => it.tab === tab);
  const prev = here > 0 ? navItems[here - 1] : null;
  const next = here >= 0 && here < navItems.length - 1 ? navItems[here + 1] : null;
  const shut = navCollapsed && !narrow;

  return (
    <div>
      <div
        className="shell"
        style={{ ["--rail" as string]: `${shut ? RAIL_SHUT : RAIL_OPEN}px` }}
      >
        <SideNav
          items={navItems}
          current={tab}
          collapsed={shut}
          onToggle={() =>
            setNavCollapsed((v) => {
              try {
                localStorage.setItem(NAV_KEY, v ? "0" : "1");
              } catch {
                // Storage blocked: the rail still toggles for this page load.
              }
              return !v;
            })
          }
          homeHref={hrefFor("home")}
          manager={manager}
          onExit={signOut}
        />

        <div className="main">
          <div className="inner">
            <div
              className="printonly"
              style={{
                marginBottom: 14,
                paddingBottom: 8,
                borderBottom: "1px solid #cfd6da",
                fontSize: 11,
                color: C.muted,
              }}
            >
              Kennion Benefit Advisors &middot; {g.name} &middot; {printLine}
            </div>

            <div
              className="panel"
              style={{
                ...panel,
                padding: "20px 22px",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 20,
              }}
            >
              <div style={{ maxWidth: 820, flex: "1 1 420px" }}>
                <h1
                  style={{
                    margin: 0,
                    fontSize: 23,
                    fontWeight: 600,
                    color: C.ink,
                    letterSpacing: "-0.2px",
                  }}
                >
                  {g.name}
                </h1>
                {/* Same wording as the side rail's current entry, so the page
                    a client lands on after clicking a link is never in doubt. */}
                <div style={{ marginTop: 6, fontSize: 15, fontWeight: 600, color: C.ink }}>{TAB_LABEL[tab]}</div>
                <div style={{ marginTop: 3, fontSize: 13, color: C.muted, lineHeight: 1.65 }}>
                  {tab === "home"
                    ? `Your 2027 renewal with Kennion Benefit Advisors · ${subline}`
                    : subline}
                </div>
              </div>
              {tab === "current" && (
                <HrAnalytics
                  eligible={g.medicalEligible}
                  enrolled={totals.enrolled}
                  contributionPct={totals.total ? (totals.er / totals.total) * 100 : 0}
                />
              )}
            </div>

            {tab === "home" ? (
              <Home
                g={g}
                currentHref={hrefFor("current")}
                optionsHref={hrefFor("options")}
                supplementalHref={hrefFor("supplemental")}
                signUpHref={hrefFor("signup")}
                changesHref={hrefFor("changes")}
                manager={manager}
                lastSignup={data.signup || null}
              />
            ) : tab === "changes" ? (
              <WhatsChanging
                data={data}
                g={g}
                rows={rows}
                totals={totals}
                optionsHref={hrefFor("options")}
                signUpHref={hrefFor("signup")}
              />
            ) : tab === "current" ? (
              <Current
                data={data}
                overrides={overrides}
                g={g}
                rows={rows}
                totals={totals}
                eePct={EE_PCT}
                depPct={DEP_PCT}
                supplementalHref={hrefFor("supplemental")}
              />
            ) : tab === "options" ? (
              <Options
                data={data}
                g={g}
                totals={totals}
                selected={selected}
                signUpHref={hrefFor("signup")}
                contribution={contribution}
                contributionValues={contributionValues}
                contributionChanged={contributionOverride != null}
                onContributionApply={(values) => setContributionOverride(values)}
                onContributionReset={() => setContributionOverride(null)}
                onToggleSelected={toggleSelected}
              />
            ) : tab === "supplemental" ? (
              <SupplementalPackage />
            ) : (
              <SignUp
                data={data}
                g={g}
                selected={selected}
                note={note}
                sent={sent}
                submitting={signupBusy}
                submitError={signupError}
                lastSignup={data.signup || null}
                optionsHref={hrefFor("options")}
                manager={manager}
                onToggleSelected={toggleSelected}
                onNote={(v) => {
                  setNote(v);
                  setSent(false);
                }}
                onSubmit={() => void submitSignup()}
              />
            )}

            <nav
              aria-label="Nearby pages"
              className="noprint"
              style={{
                marginTop: 26,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <span>
                {prev && (
                  <Link href={prev.href} style={{ fontSize: 13.5 }}>
                    &larr; Back: {prev.label}
                  </Link>
                )}
              </span>
              <span>
                {next && (
                  <Link href={next.href} style={{ fontSize: 13.5 }}>
                    Next: {next.label} &rarr;
                  </Link>
                )}
              </span>
            </nav>

            <Footer />
          </div>
        </div>
      </div>
    </div>
  );
}
