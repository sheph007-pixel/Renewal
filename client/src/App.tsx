import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ovKey,
  planRows,
  type KennionData,
  type Overrides,
} from "@/lib/model";
import { C, Logo, panel } from "@/lib/ui";
import { PATHS, currentPage, linkPath, navigate, parsePath, useRoute } from "@/lib/router";
import Link from "@/lib/Link";
import { clearSession, loadSession, saveSession } from "@/lib/session";
import Login from "@/views/Login";
import Footer from "@/views/Footer";
import Admin, { type ImportRecord } from "@/views/Admin";
import type { CarrierStats } from "@/views/Reconciliation";
import type { FundingInfo } from "@/views/Funding";
import Current, { CURRENT_SECTIONS } from "@/views/Current";
import Options, { OPTIONS_SECTIONS, type SortKey } from "@/views/Options";
import SectionNav from "@/views/SectionNav";

/**
 * Placeholder employer-contribution percentages, used only for groups whose
 * Employee Navigator export has not been loaded. Where EN data exists the real
 * split is used and these are ignored entirely.
 */
const EE_PCT = 80;
const DEP_PCT = 32;

const SITE = "Kennion 2027 Renewal";

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

/** The permanent group token in the address at load, if the address is /g/<token>. */
function tokenAtLoad(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/^\/g\/([A-Za-z0-9_-]{8,64})(?:\/options)?\/?$/);
  return m ? m[1] : null;
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
  /** The group's permanent token, when the address is /g/<token>. */
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(
    () => linkCodeAtLoad() != null || tokenAtLoad() != null || loadSession() != null,
  );
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

  const [sort, setSort] = useState<SortKey>("monthly");
  const [dir, setDir] = useState(1);
  const [gridQuery, setGridQuery] = useState("");
  const [carriers, setCarriers] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

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
    } as KennionData);
    setCode(group.code);
    setLinkToken((p.linkToken as string) || null);
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
          const home = p.linkToken ? linkPath(p.linkToken) : PATHS.current;
          if (asked.kind !== "group" || asked.token !== p.linkToken) navigate(home, { replace: true });
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
          navigate(p.linkToken ? linkPath(p.linkToken) : PATHS.current, { replace: true });
        } catch {
          setLoadError(true);
        } finally {
          setRestoring(false);
        }
      })();
      return;
    }

    const s = loadSession();
    if (!s) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        if (s.kind === "group") {
          const r = await fetch("/api/signin", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: s.code }),
          });
          if (!r.ok) throw new Error("expired");
          applyGroup(await r.json());
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

  const session: "none" | "group" | "admin" = admin ? "admin" : g ? "group" : "none";

  /**
   * Keep the address and the session consistent. A group at an admin address
   * (or the other way round) goes to its own home; an address that is not a
   * page at all goes to sign-in. `replace` so the back button is not trapped.
   */
  useEffect(() => {
    if (restoring) return;
    if (session === "admin" && page.kind !== "admin") navigate(PATHS.groups, { replace: true });
    else if (session === "group" && page.kind !== "group")
      navigate(linkToken ? linkPath(linkToken) : PATHS.current, { replace: true });
    else if (session === "none" && page.kind === "unknown") navigate(PATHS.signin, { replace: true });
  }, [restoring, session, page.kind]);

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
    else if (page.kind === "group" && g)
      t = `${page.tab === "current" ? "Current Medical Plan(s)" : "2027 Medical Plan Options"} — ${g.name}`;
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
        <div style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "0 22px" }}>
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

  const tabBase = {
    display: "flex",
    alignItems: "center",
    borderBottom: "3px solid transparent",
    padding: "0 15px",
    fontSize: 13.5,
    color: C.body,
    textDecoration: "none",
  };
  const tabOn = {
    ...tabBase,
    borderBottom: `3px solid ${C.orange}`,
    fontWeight: 600,
    color: C.ink,
  };

  /**
   * The program runs on the calendar year, so every group's page says the same
   * thing. A handful of groups carry a mid-year date because that is when they
   * joined, not because their plan year differs, and showing 04/01 there read
   * as a different plan year to anyone comparing two groups.
   */
  const planYear = (g.pyEnd || "2026-12-31").slice(0, 4);
  const subline =
    tab === "options"
      ? "Effective January 1, 2027"
      : `Calendar Year (January 1 \u2013 December 31, ${planYear})`;

  const printLine =
    (tab === "current"
      ? `Current group health plans and cost, calendar year ${planYear}`
      : "2027 renewal options, effective January 1, 2027") +
    ` · data as of 7/31/2026 · printed ${new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })}`;

  // With a permanent address, both tabs live under it, so the token stays in
  // the bar wherever the client clicks.
  const pages = [
    [linkToken ? linkPath(linkToken, "current") : PATHS.current, "current", "Current Medical Plan(s)"],
    [linkToken ? linkPath(linkToken, "options") : PATHS.options, "options", "2027 Medical Plan Options"],
  ] as const;

  return (
    <div>
      <div
        className="noprint"
        style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "0 22px" }}
      >
        <div
          style={{
            maxWidth: 1400,
            margin: "0 auto",
            height: 48,
            display: "flex",
            alignItems: "stretch",
            justifyContent: "space-between",
            gap: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <Link href={linkToken ? linkPath(linkToken) : PATHS.current} aria-label="Home" style={{ display: "block" }}>
              <img
                src={Logo}
                alt="Kennion Benefit Advisors"
                style={{ height: 28, display: "block" }}
              />
            </Link>
          </div>
          <nav aria-label="Pages" style={{ display: "flex", alignItems: "stretch", gap: 2 }}>
            {pages.map(([href, key, label]) => (
              <Link
                key={key}
                href={href}
                aria-current={tab === key ? "page" : undefined}
                style={tab === key ? tabOn : tabBase}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <button
              onClick={signOut}
              style={{
                background: "none",
                border: "none",
                fontSize: 13.5,
                color: C.blue,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Exit
            </button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "20px 22px 60px" }}>
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
            <div style={{ marginTop: 8, fontSize: 13, color: C.muted, lineHeight: 1.65 }}>
              {subline}
            </div>
            <SectionNav
              sections={tab === "current" ? CURRENT_SECTIONS : OPTIONS_SECTIONS}
              current={route.hash}
            />
          </div>

        </div>

        {tab === "current" ? (
          <Current
            data={data}
            overrides={overrides}
            g={g}
            rows={rows}
            totals={totals}
            eePct={EE_PCT}
            depPct={DEP_PCT}
          />
        ) : (
          <Options
            data={data}
            g={g}
            rows={rows}
            totals={totals}
            sort={sort}
            dir={dir}
            gridQuery={gridQuery}
            carriers={carriers}
            selected={selected}
            note={note}
            sent={sent}
            onSort={(k) => {
              setDir((d) => (sort === k ? -d : 1));
              setSort(k);
            }}
            onGridQuery={setGridQuery}
            onToggleCarrier={(c) => setCarriers((prev) => ({ ...prev, [c]: !prev[c] }))}
            onToggleSelected={toggleSelected}
            onNote={(v) => {
              setNote(v);
              setSent(false);
            }}
            onSend={() => setSent(true)}
          />
        )}

        <nav
          aria-label="Next page"
          className="noprint"
          style={{
            marginTop: 26,
            display: "flex",
            justifyContent: tab === "current" ? "flex-end" : "flex-start",
          }}
        >
          {tab === "current" ? (
            <Link href={linkToken ? linkPath(linkToken, "options") : PATHS.options} style={{ fontSize: 13.5 }}>
              Next: 2027 Medical Plan Options &rarr;
            </Link>
          ) : (
            <Link href={linkToken ? linkPath(linkToken) : PATHS.current} style={{ fontSize: 13.5 }}>
              &larr; Back: Current Medical Plan(s)
            </Link>
          )}
        </nav>

        <div
          className="noprint"
          style={{
            marginTop: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
          }}
        >
          <span style={{ fontSize: 11, color: C.ghost }}>powered by</span>
          <img
            src={Logo}
            alt="Kennion Benefit Advisors"
            style={{ height: 24, display: "block" }}
          />
        </div>
      </div>

      <Footer />
    </div>
  );
}
