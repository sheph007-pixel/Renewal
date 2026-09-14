import { useEffect, useRef, useState, type ReactNode } from "react";
import { BenSyncDark, C } from "@/lib/ui";
import Link from "@/lib/Link";
import type { GroupTab } from "@/lib/router";
import type { AccountManager } from "@/lib/model";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

/** Where a client opens a support ticket directly, without going through email. */
export const SUPPORT_URL = "https://support.kennion.com/support/tickets/new";

export interface NavItem {
  tab: GroupTab;
  href: string;
  label: string;
  /** This page's step number, 1 through 5 — Welcome carries none. Kept for prev / next. */
  step?: number;
  /** Welcome's badge shows a house instead of a number. */
  mark?: "home";
  /** True only for Sign Up: the one page that is an action rather than a read. */
  cta?: boolean;
}

/** The rail's width, which the shell reads as `--rail` to move the page over. */
export const RAIL_OPEN = 248;
export const RAIL_SHUT = 64;

interface Props {
  items: NavItem[];
  current: GroupTab;
  collapsed: boolean;
  onToggle: () => void;
  homeHref: string;
  /** The client's name: the rail is theirs, so it sits top-left. */
  groupName: string;
  manager: AccountManager | null | undefined;
  onExit: () => void;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** One small line icon per page, so the rail reads at a glance. */
function TabIcon({ tab }: { tab: GroupTab }) {
  const s = { width: 15, height: 15, viewBox: "0 0 24 24", ...stroke };
  switch (tab) {
    case "home":
      return (
        <svg {...s}>
          <path d="M3.5 11.5 12 4l8.5 7.5" />
          <path d="M6 10v9a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1v-9" />
        </svg>
      );
    case "changes":
      return (
        <svg {...s}>
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
        </svg>
      );
    case "current":
      return (
        <svg {...s}>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="4" cy="6" r="1" fill="currentColor" />
          <circle cx="4" cy="12" r="1" fill="currentColor" />
          <circle cx="4" cy="18" r="1" fill="currentColor" />
        </svg>
      );
    case "options":
      return (
        <svg {...s}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "supplemental":
      return (
        <svg {...s}>
          <path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6l7-3Z" />
          <path d="M9.5 12l1.8 1.8L15 10" />
        </svg>
      );
    case "signup":
      return (
        <svg {...s}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M8.5 12.2l2.3 2.3L15.5 9.8" />
        </svg>
      );
  }
}

function GridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
      <path d="M13 6v2M13 11v2M13 16v2" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M19 12H10M19 12l-3-3M19 12l-3 3" />
    </svg>
  );
}

const telHref = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

/** "Acme Roofing, Inc." → "AR": the client's mark at the top of their rail. */
export function monogram(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9 &]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(inc|llc|co|corp|corporation|company|the|of|and|&|ltd|pc|pllc|lp)$/i.test(w));
  const a = words[0]?.[0] || name[0] || "?";
  const b = words[1]?.[0] || "";
  return (a + b).toUpperCase();
}

/** One row in the rail's footer: an icon, a label, an outbound arrow for links that leave the site. */
function LinkRow({ icon, label, href, external, onClick }: { icon: ReactNode; label: string; href?: string; external?: boolean; onClick?: () => void }) {
  const style = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 10px",
    borderRadius: 7,
    fontSize: 12.5,
    fontWeight: 500,
    color: C.railInk,
    textDecoration: "none",
    background: "none",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    cursor: "pointer",
  };
  const inner = (
    <>
      <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", color: C.railMuted }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {external && (
        <span aria-hidden style={{ color: C.railMuted, fontSize: 11 }}>
          &#8599;
        </span>
      )}
    </>
  );
  if (href) {
    return (
      <a className="rail-row" href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} style={style}>
        {inner}
      </a>
    );
  }
  return (
    <button className="rail-row" onClick={onClick} style={style}>
      {inner}
    </button>
  );
}

/**
 * The account manager as one quiet row — avatar and name — that opens a
 * small card with phone, email and a meeting link. Contact details are a
 * click away rather than a block of text in the navigation.
 */
function ManagerRow({ manager, compact }: { manager: AccountManager; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const avatar = (
    <span
      aria-hidden
      style={{ display: "grid", placeItems: "center", flex: "none", width: compact ? 30 : 28, height: compact ? 30 : 28, borderRadius: "50%", background: C.blue, color: "#fff", fontSize: 11, fontWeight: 700 }}
    >
      {monogram(manager.name)}
    </span>
  );
  return (
    <div ref={box} className="rail-manager" style={{ position: "relative", margin: compact ? 0 : "0 8px 6px" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={compact ? `${manager.name} · Your Account Manager` : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "center" : "flex-start",
          gap: 10,
          width: "100%",
          padding: compact ? 0 : "8px 10px",
          borderRadius: 8,
          background: open ? C.railActive : compact ? "none" : "rgba(255,255,255,0.05)",
          border: compact ? "none" : `1px solid ${open ? C.teal : C.railLine}`,
          color: C.railInk,
          cursor: "pointer",
          textAlign: "left",
          textTransform: "none",
        }}
      >
        {avatar}
        {!compact && (
          <>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{manager.name}</span>
              <span style={{ display: "block", fontSize: 11, color: C.teal, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Account Manager · Contact</span>
            </span>
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" {...stroke} style={{ flex: "none", color: C.railMuted, transform: open ? "rotate(180deg)" : "none" }}>
              <path d="M6 15l6-6 6 6" />
            </svg>
          </>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Contact ${manager.name}`}
          style={{
            position: "absolute",
            left: compact ? "calc(100% + 10px)" : 0,
            bottom: compact ? 0 : "calc(100% + 6px)",
            width: 232,
            padding: "12px 14px",
            borderRadius: 10,
            background: "#fff",
            color: C.ink,
            boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
            zIndex: 20,
          }}
        >
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.4px", color: C.faint, textTransform: "uppercase" }}>Your Account Manager</div>
          <div style={{ marginTop: 2, fontSize: 14.5, fontWeight: 700, color: C.ink }}>{manager.name}</div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5, fontSize: 13 }}>
            {manager.phone && <a href={telHref(manager.phone)}>{manager.phone}</a>}
            {manager.email && (
              <a href={`mailto:${manager.email}`} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {manager.email}
              </a>
            )}
          </div>
          {manager.calendly && (
            <a
              className="cta"
              href={manager.calendly}
              target="_blank"
              rel="noreferrer"
              style={{ display: "block", marginTop: 12, padding: "8px 12px", borderRadius: 6, background: C.blue, color: "#fff", fontSize: 13, fontWeight: 600, textAlign: "center" }}
            >
              Schedule A Meeting &#8599;
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The client's navigation: a dark rail down the left with their name at the
 * top, the pages in the middle, and who to call at the bottom. It stays put
 * while a long rate grid scrolls past it, and collapses to icons for anyone
 * who wants the width back; collapsed or not, the links are the same links.
 */
export default function SideNav({ items, current, collapsed, onToggle, homeHref, groupName, manager, onExit }: Props) {
  const toggle = (
    <button
      className="collapse-btn"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand navigation" : "Collapse navigation"}
      style={{
        display: "grid",
        placeItems: "center",
        width: 26,
        height: 26,
        flex: "none",
        background: "none",
        border: `1px solid ${C.railLine}`,
        borderRadius: 6,
        fontSize: 15,
        lineHeight: 1,
        color: C.railMuted,
        cursor: "pointer",
      }}
    >
      {collapsed ? <>&raquo;</> : <>&laquo;</>}
    </button>
  );

  return (
    <div className="sidebar noprint" style={{ background: C.rail, color: C.railInk }}>
      <div
        className="brand"
        style={{
          padding: collapsed ? "12px 8px 8px" : "14px 14px 10px",
          borderBottom: `1px solid ${C.railLine}`,
        }}
      >
        {!collapsed && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
            <Link href={homeHref} aria-label="BenSync home" style={{ display: "block", lineHeight: 0 }}>
              <img src={BenSyncDark} alt="BenSync" style={{ height: 18, display: "block" }} />
            </Link>
            {toggle}
          </div>
        )}
        <Link href={homeHref} aria-label={`${groupName} home`} title={groupName} style={{ display: "flex", alignItems: "center", justifyContent: collapsed ? "center" : "flex-start", gap: 10, minWidth: 0, color: "inherit", textDecoration: "none" }}>
          <span
            aria-hidden
            style={{
              display: "grid",
              placeItems: "center",
              flex: "none",
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: C.railActive,
              border: `1px solid ${C.railLine}`,
              color: C.teal,
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.3px",
            }}
          >
            {monogram(groupName)}
          </span>
          {!collapsed && (
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontSize: 13,
                  fontWeight: 600,
                  lineHeight: 1.25,
                  color: "#fff",
                  letterSpacing: "-0.1px",
                }}
              >
                {groupName}
              </span>
            </span>
          )}
        </Link>
      </div>
      {collapsed && <div style={{ display: "grid", placeItems: "center", padding: "8px 0 0" }}>{toggle}</div>}

      <nav className="rail-nav" aria-label="Pages" style={{ padding: "8px 8px 6px", display: "flex", flexDirection: "column", gap: 1 }}>
        {items.map((it) => {
          const on = it.tab === current;
          return (
            <Link
              key={it.tab}
              className="rail-item"
              href={it.href}
              aria-current={on ? "page" : undefined}
              title={collapsed ? it.label : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                gap: 10,
                padding: collapsed ? "9px 0" : "7px 10px",
                borderRadius: 7,
                background: on ? C.railActive : "transparent",
                color: on ? "#fff" : it.cta ? C.tealInk : C.railInk,
                fontWeight: on || it.cta ? 600 : 500,
                fontSize: 13,
                textDecoration: "none",
              }}
            >
              <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", color: on ? "#fff" : it.cta ? C.tealInk : C.railMuted }}>
                <TabIcon tab={it.tab} />
              </span>
              {!collapsed && (
                <span style={{ minWidth: 0, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
              )}
              {!collapsed && it.cta && !on && <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: C.teal }} />}
            </Link>
          );
        })}
      </nav>

      <div className="rail-foot" style={{ marginTop: "auto" }}>
        {collapsed ? (
          <div style={{ padding: "8px 8px 12px", borderTop: `1px solid ${C.railLine}`, display: "grid", gap: 6, justifyItems: "center" }}>
            {manager?.name && <ManagerRow manager={manager} compact />}
            <a href={NAVIGATOR_URL} target="_blank" rel="noreferrer" title="Employee Navigator" style={{ display: "grid", placeItems: "center", padding: 6, color: C.railMuted }}>
              <GridIcon />
            </a>
            <a href={SUPPORT_URL} target="_blank" rel="noreferrer" title="Support Ticket" style={{ display: "grid", placeItems: "center", padding: 6, color: C.railMuted }}>
              <TicketIcon />
            </a>
            <button onClick={onExit} title="Log Out" style={{ display: "grid", placeItems: "center", padding: 6, background: "none", border: "none", color: C.railMuted, cursor: "pointer" }}>
              <LogOutIcon />
            </button>
          </div>
        ) : (
          <>
            {manager?.name && <ManagerRow manager={manager} />}

            <div className="rail-links" style={{ padding: "6px 8px 8px", borderTop: `1px solid ${C.railLine}` }}>
              <LinkRow icon={<GridIcon />} label="Employee Navigator" href={NAVIGATOR_URL} external />
              <LinkRow icon={<TicketIcon />} label="Support Ticket" href={SUPPORT_URL} external />
              <LinkRow icon={<LogOutIcon />} label="Log Out" onClick={onExit} />
            </div>
            <div className="rail-brand" style={{ padding: "0 18px 12px", fontSize: 10.5, color: C.railMuted, letterSpacing: "0.2px" }}>
              Powered by <span style={{ color: C.railInk, fontWeight: 600 }}>Kennion Benefit Advisors</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
