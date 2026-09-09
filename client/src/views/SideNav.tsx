import type { ReactNode } from "react";
import { C, Logo } from "@/lib/ui";
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
  /**
   * This page's step number, 1 through 5 — Welcome carries none, it is
   * where you start rather than a stop along the way. The numbering says
   * what a tab strip cannot: there is an order here.
   */
  step?: number;
  /** Welcome's badge shows a house instead of a number. */
  mark?: "home";
  /** True only for Sign Up: the one page that is an action rather than a read. */
  cta?: boolean;
}

/** The rail's width, which the shell reads as `--rail` to move the page over. */
export const RAIL_OPEN = 296;
export const RAIL_SHUT = 64;

interface Props {
  items: NavItem[];
  current: GroupTab;
  collapsed: boolean;
  onToggle: () => void;
  homeHref: string;
  manager: AccountManager | null | undefined;
  onExit: () => void;
}

/** A small house glyph for Welcome — plainer than a wordmark, clearer than a letter. */
function HomeIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 11.5 12 4l8.5 7.5" />
      <path d="M6 10v9a1 1 0 0 0 1 1h3.5v-6h3v6H17a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

/** A little grid — Employee Navigator's own kind of mark, so it reads as "another system." */
function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </svg>
  );
}

/** A support ticket. */
function TicketIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z" />
      <path d="M13 6v2M13 11v2M13 16v2" />
    </svg>
  );
}

/** A door with an arrow out — logging out. */
function LogOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
      <path d="M19 12H10M19 12l-3-3M19 12l-3 3" />
    </svg>
  );
}

const telHref = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

/**
 * One row in the Links section: an icon, a label, and — only for a link that
 * leaves the site — the same outbound arrow used everywhere else on these
 * pages. Log Out is the one row that is a button, not a link, and carries no
 * arrow, since it goes nowhere external.
 */
function LinkRow({
  icon,
  label,
  href,
  external,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
}) {
  const style = {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 500,
    color: C.body,
    textDecoration: "none",
    background: "none",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    cursor: "pointer",
  };
  const inner = (
    <>
      <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", color: C.faint }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {external && (
        <span aria-hidden style={{ color: C.faint, fontSize: 11 }}>
          &#8599;
        </span>
      )}
    </>
  );
  if (href) {
    return (
      <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} style={style}>
        {inner}
      </a>
    );
  }
  return (
    <button onClick={onClick} style={style}>
      {inner}
    </button>
  );
}

/**
 * The site's navigation: a full-height rail down the left, which is how
 * software this shape is normally laid out and what an employer already knows
 * from Employee Navigator. It carries the brand at the top, the pages in the
 * middle — numbered, since there is a real order to Welcome through Sign Up —
 * and who to call at the bottom, in a block of its own rather than folded
 * into the same list. It stays put while a long rate grid scrolls past it.
 *
 * It collapses to marks for anyone who wants the width back, and the choice
 * is remembered by the caller. Collapsed or not, the links are the same
 * links, so nothing is reachable in only one state.
 */
export default function SideNav({
  items,
  current,
  collapsed,
  onToggle,
  homeHref,
  manager,
  onExit,
}: Props) {
  return (
    <div
      className="sidebar noprint"
      style={{ background: C.card, borderRight: `1px solid ${C.border}` }}
    >
      <div
        className="brand"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          gap: 8,
          padding: collapsed ? "14px 8px" : "16px 14px",
          borderBottom: `1px solid ${C.hairline}`,
        }}
      >
        {/* The wordmark does not fit a 64px rail, so a collapsed rail carries
            the initial instead of a logo squeezed to illegibility. */}
        <Link href={homeHref} aria-label="Home" style={{ display: "block", minWidth: 0 }}>
          {collapsed ? (
            <span
              style={{
                display: "grid",
                placeItems: "center",
                width: 30,
                height: 30,
                borderRadius: 5,
                background: C.blue,
                color: "#fff",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              K
            </span>
          ) : (
            <img
              src={Logo}
              alt="Kennion Benefit Advisors"
              style={{ height: 28, display: "block", maxWidth: "100%" }}
            />
          )}
        </Link>
        {!collapsed && (
          <button
            className="collapse-btn"
            onClick={onToggle}
            aria-expanded
            title="Collapse navigation"
            style={{
              display: "grid",
              placeItems: "center",
              width: 30,
              height: 30,
              flex: "none",
              background: "none",
              border: `1px solid ${C.border}`,
              borderRadius: 5,
              fontSize: 17,
              lineHeight: 1,
              color: C.body,
              cursor: "pointer",
            }}
          >
            &laquo;
          </button>
        )}
      </div>

      {collapsed && (
        <button
          className="collapse-btn"
          onClick={onToggle}
          aria-expanded={false}
          title="Expand navigation"
          style={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            margin: "10px auto 0",
            background: "none",
            border: `1px solid ${C.border}`,
            borderRadius: 5,
            fontSize: 17,
            lineHeight: 1,
            color: C.body,
            cursor: "pointer",
          }}
        >
          &raquo;
        </button>
      )}

      <nav className="rail-nav" aria-label="Pages" style={{ padding: 10 }}>
        {items.map((it, i) => {
          const on = it.tab === current;
          // Every badge is filled when it is the current page. Sign Up's badge
          // is filled green always — the one step that is an action, not a
          // read — so it stands out from the list even when you are not on it.
          const badgeBg = it.cta ? C.green : on ? C.blue : C.hairline;
          const badgeFg = it.cta || on ? "#fff" : C.faint;
          return (
            <div key={it.tab}>
              {i > 0 && <div aria-hidden style={{ height: 1, margin: collapsed ? "4px 4px" : "4px 12px", background: C.hairline }} />}
              <Link
                href={it.href}
                aria-current={on ? "page" : undefined}
                title={collapsed ? it.label : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: collapsed ? "center" : "flex-start",
                  gap: 12,
                  padding: collapsed ? "13px 0" : "13px 12px",
                  borderRadius: 6,
                  border: `1px solid ${it.cta && !on ? C.greenEdge : "transparent"}`,
                  borderLeft: `3px solid ${on ? C.orange : it.cta ? C.green : "transparent"}`,
                  background: on ? C.blueTint : it.cta ? C.greenTint : "transparent",
                  color: on ? C.ink : C.body,
                  textDecoration: "none",
                }}
              >
              <span
                aria-hidden
                style={{
                  flex: "none",
                  width: 26,
                  height: 26,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "50%",
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: badgeFg,
                  background: badgeBg,
                }}
              >
                {it.step != null ? it.step : <HomeIcon color={badgeFg} />}
              </span>
              {!collapsed && (
                <span
                  style={{
                    minWidth: 0,
                    flex: 1,
                    fontSize: 14.5,
                    fontWeight: 700,
                    letterSpacing: "-0.1px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: it.cta && !on ? C.green : undefined,
                  }}
                >
                  {it.label}
                </span>
              )}
              </Link>
            </div>
          );
        })}
      </nav>

      {/* Pinned to the bottom of the rail: who to call about the group, then
          the standing links every page shares. Two blocks, not one drawer —
          the account manager is a person and gets a card of their own; the
          rest are destinations and read as a plain, labelled list under it. */}
      <div className="rail-foot" style={{ marginTop: "auto" }}>
        {collapsed ? (
          <div style={{ padding: 8, borderTop: `1px solid ${C.hairline}` }}>
            {manager?.name && (
              <a
                href={telHref(manager.phone || "")}
                title={manager.name}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 30,
                  height: 30,
                  margin: "0 auto",
                  borderRadius: "50%",
                  background: C.blueTint,
                  color: C.blueInk,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {manager.name[0]}
              </a>
            )}
            <a
              href={NAVIGATOR_URL}
              target="_blank"
              rel="noreferrer"
              title="Employee Navigator"
              style={{ display: "grid", placeItems: "center", padding: "8px 0", color: C.faint }}
            >
              <GridIcon />
            </a>
            <a
              href={SUPPORT_URL}
              target="_blank"
              rel="noreferrer"
              title="Support Ticket"
              style={{ display: "grid", placeItems: "center", padding: "0 0 6px", color: C.faint }}
            >
              <TicketIcon />
            </a>
            <button
              onClick={onExit}
              title="Log Out"
              style={{
                display: "grid",
                placeItems: "center",
                width: "100%",
                padding: "6px 0 0",
                background: "none",
                border: "none",
                color: C.faint,
                cursor: "pointer",
              }}
            >
              <LogOutIcon />
            </button>
          </div>
        ) : (
          <>
            {manager?.name && (
              <div
                className="rail-manager"
                style={{
                  margin: "10px 10px 0",
                  padding: "12px 14px",
                  borderRadius: 8,
                  background: C.blueTint,
                  border: `1px solid ${C.blueEdge}`,
                }}
              >
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    letterSpacing: "0.5px",
                    color: C.blueInk,
                    textTransform: "uppercase",
                  }}
                >
                  Your account manager
                </div>
                <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, color: C.ink }}>
                  {manager.name}
                </div>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  {manager.phone && (
                    <a href={telHref(manager.phone)} style={{ fontSize: 12.5, color: C.blueInk, fontWeight: 500 }}>
                      {manager.phone}
                    </a>
                  )}
                  {manager.email && (
                    <a href={`mailto:${manager.email}`} style={{ fontSize: 12.5, color: C.blueInk, fontWeight: 500 }}>
                      {manager.email}
                    </a>
                  )}
                  {manager.calendly && (
                    <a
                      href={manager.calendly}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12.5, color: C.blueInk, fontWeight: 700 }}
                    >
                      Schedule a Meeting &#8599;
                    </a>
                  )}
                </div>
              </div>
            )}

            <div className="rail-links" style={{ marginTop: 10, padding: "10px 0", borderTop: `1px solid ${C.hairline}` }}>
              <div style={{ padding: "0 14px 4px", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.5px", color: C.ghost, textTransform: "uppercase" }}>
                Links
              </div>
              <LinkRow icon={<GridIcon />} label="Employee Navigator" href={NAVIGATOR_URL} external />
              <LinkRow icon={<TicketIcon />} label="Support Ticket" href={SUPPORT_URL} external />
              <LinkRow icon={<LogOutIcon />} label="Log Out" onClick={onExit} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
