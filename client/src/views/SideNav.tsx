import { C, Logo } from "@/lib/ui";
import Link from "@/lib/Link";
import type { GroupTab } from "@/lib/router";
import type { AccountManager } from "@/lib/model";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

export interface NavItem {
  tab: GroupTab;
  href: string;
  label: string;
  /** The mark shown when the rail is collapsed. */
  mark: string;
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
  manager: AccountManager | null | undefined;
  onExit: () => void;
}

/**
 * The site's navigation: a full-height rail down the left, which is how
 * software this shape is normally laid out and what an employer already knows
 * from Employee Navigator. It carries the brand at the top, the pages in the
 * middle and who to call at the bottom, and it stays put while a long rate
 * grid scrolls past it.
 *
 * A column has room to grow that a tab strip does not — another page is
 * another row — and each row is the page name itself, set big and bold, so
 * the five pages read as a list rather than a row of small print. It
 * collapses to marks for anyone who wants the width back, and the choice is
 * remembered by the caller. Collapsed or not, the links are the same links, so
 * nothing is reachable in only one state.
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
  const quiet = { fontSize: 11, fontWeight: 600, letterSpacing: "0.4px", color: C.ghost, textTransform: "uppercase" as const };
  const quickLink = { display: "block", padding: "6px 12px", fontSize: 12.5, color: C.blue };

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
          padding: collapsed ? "14px 8px" : "14px 12px",
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
            style={{ background: "none", border: "none", padding: 4, fontSize: 15, color: C.faint, cursor: "pointer" }}
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
            margin: "8px auto 0",
            background: "none",
            border: "none",
            padding: 4,
            fontSize: 15,
            color: C.faint,
            cursor: "pointer",
          }}
        >
          &raquo;
        </button>
      )}

      <nav className="rail-nav" aria-label="Pages" style={{ padding: 8 }}>
        {items.map((it) => {
          const on = it.tab === current;
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
                marginBottom: 3,
                borderRadius: 5,
                borderLeft: `3px solid ${on ? C.orange : "transparent"}`,
                background: on ? C.blueTint : "transparent",
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
                  borderRadius: 4,
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: on ? "#fff" : C.faint,
                  background: on ? C.blue : C.hairline,
                }}
              >
                {it.mark}
              </span>
              {!collapsed && (
                <span style={{ minWidth: 0, fontSize: 15, fontWeight: 700, letterSpacing: "-0.1px" }}>
                  {it.label}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Pinned to the bottom of the rail: where the detail lives, and who to
          call about it. On every page, not just the one that mentions them. */}
      <div
        className="rail-foot"
        style={{ marginTop: "auto", padding: collapsed ? 8 : 12, borderTop: `1px solid ${C.hairline}` }}
      >
        {collapsed ? (
          <>
            <a
              href={NAVIGATOR_URL}
              target="_blank"
              rel="noreferrer"
              title="Employee Navigator"
              style={{ display: "grid", placeItems: "center", padding: "8px 0", fontSize: 12, fontWeight: 700, color: C.blue }}
            >
              EN
            </a>
            <button
              onClick={onExit}
              title="Exit"
              style={{
                display: "block",
                width: "100%",
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
          </>
        ) : (
          <>
            <div className="rail-head" style={{ ...quiet, padding: "0 12px 4px" }}>Quick links</div>
            <a href={NAVIGATOR_URL} target="_blank" rel="noreferrer" style={quickLink}>
              Employee Navigator &#8599;
            </a>
            {manager?.name && (
              <div className="rail-manager" style={{ marginTop: 10, padding: "10px 12px 0", borderTop: `1px solid ${C.hairline}` }}>
                <div className="rail-head" style={quiet}>Your account manager</div>
                <div style={{ marginTop: 5, fontSize: 13, fontWeight: 600, color: C.ink }}>
                  {manager.name}
                </div>
                {manager.phone && (
                  <a
                    href={`tel:${manager.phone.replace(/[^0-9+]/g, "")}`}
                    style={{ display: "block", marginTop: 2, fontSize: 12.5, color: C.blue }}
                  >
                    {manager.phone}
                  </a>
                )}
                {manager.calendly && (
                  <a
                    href={manager.calendly}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: "block", marginTop: 2, fontSize: 12.5, color: C.blue }}
                  >
                    Book a time &#8599;
                  </a>
                )}
              </div>
            )}
            <button
              onClick={onExit}
              style={{
                margin: "12px 0 0",
                padding: "0 12px",
                background: "none",
                border: "none",
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
