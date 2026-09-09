import { C, Logo } from "@/lib/ui";
import Link from "@/lib/Link";
import type { GroupTab } from "@/lib/router";
import type { AccountManager } from "@/lib/model";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

export interface NavItem {
  tab: GroupTab;
  href: string;
  label: string;
  /**
   * This page's step number, 1 through 4 — Welcome carries none, it is the
   * home icon instead. The numbering says what a tab strip cannot: there is
   * an order here, and Sign Up is where it ends.
   */
  step?: number;
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

const telHref = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, "")}`;

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
      style={{ background: "#fff", borderRight: `1px solid ${C.border}` }}
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
        {items.map((it) => {
          const on = it.tab === current;
          // Every badge is filled when it is the current page. Sign Up's badge
          // is filled green always — the one step that is an action, not a
          // read — so it stands out from the list even when you are not on it.
          const badgeBg = it.cta ? C.green : on ? C.blue : C.hairline;
          const badgeFg = it.cta || on ? "#fff" : C.faint;
          return (
            <Link
              key={it.tab}
              href={it.href}
              aria-current={on ? "page" : undefined}
              title={collapsed ? it.label : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                gap: 12,
                padding: collapsed ? "13px 0" : "13px 12px",
                marginBottom: 4,
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
                {it.step == null ? <HomeIcon color={badgeFg} /> : it.step}
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
          );
        })}
      </nav>

      {/* Pinned to the bottom of the rail: where the detail lives, and who to
          call about it. Its own block, set apart with a tint and a rule, so it
          reads as "the people", not one more row in the page list above. */}
      <div className="rail-foot" style={{ marginTop: "auto" }}>
        {collapsed ? (
          <div style={{ padding: 8, borderTop: `1px solid ${C.hairline}` }}>
            <a
              href={NAVIGATOR_URL}
              target="_blank"
              rel="noreferrer"
              title="Employee Navigator"
              style={{ display: "grid", placeItems: "center", padding: "8px 0", fontSize: 12, fontWeight: 700, color: C.blue }}
            >
              EN
            </a>
            {manager?.name && (
              <a
                href={telHref(manager.phone || "")}
                title={manager.name}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 30,
                  height: 30,
                  margin: "6px auto 0",
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
            <button
              onClick={onExit}
              title="Exit"
              style={{
                display: "block",
                width: "100%",
                marginTop: 6,
                padding: "6px 0",
                background: "none",
                border: "none",
                fontSize: 11.5,
                color: C.faint,
                cursor: "pointer",
              }}
            >
              Exit
            </button>
          </div>
        ) : (
          <>
            <div className="rail-links" style={{ padding: "10px 14px", borderTop: `1px solid ${C.hairline}` }}>
              <a href={NAVIGATOR_URL} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: C.blue }}>
                Employee Navigator &#8599;
              </a>
            </div>

            {manager?.name && (
              <div
                className="rail-manager"
                style={{
                  margin: "0 10px 10px",
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

            <button
              onClick={onExit}
              style={{
                display: "block",
                width: "100%",
                padding: "0 14px 12px",
                background: "none",
                border: "none",
                textAlign: "left",
                fontSize: 12.5,
                color: C.faint,
                cursor: "pointer",
              }}
            >
              Exit
            </button>
          </>
        )}
      </div>
    </div>
  );
}
