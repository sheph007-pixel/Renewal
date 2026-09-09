import { C, panel } from "@/lib/ui";
import Link from "@/lib/Link";
import type { GroupTab } from "@/lib/router";
import type { AccountManager } from "@/lib/model";
import { NAVIGATOR_URL } from "@/views/NavigatorCard";

export interface NavItem {
  tab: GroupTab;
  href: string;
  label: string;
  /** One line under the label saying what the page answers. */
  note: string;
  /** The mark shown when the rail is collapsed. */
  mark: string;
}

interface Props {
  items: NavItem[];
  current: GroupTab;
  collapsed: boolean;
  onToggle: () => void;
  manager: AccountManager | null | undefined;
}

/**
 * The site's navigation, down the left rather than across the top. A column
 * has room for a line under each page saying what it answers, which a tab
 * strip does not, and it has room to grow: another page is another row, not a
 * tab strip that runs out of width.
 *
 * It collapses to a rail for anyone who wants the width back, and the choice is
 * remembered by the caller. Collapsed or not, the links are the same links, so
 * nothing is reachable only in one state.
 */
export default function SideNav({ items, current, collapsed, onToggle, manager }: Props) {
  const width = collapsed ? 62 : 232;
  return (
    <nav
      className="sidebar noprint"
      aria-label="Sections"
      style={{ ...panel, width, padding: 8, overflow: "hidden" }}
    >
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand navigation" : "Collapse navigation"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "7px 9px",
          marginBottom: 4,
          background: "none",
          border: "none",
          borderRadius: 4,
          fontSize: 12.5,
          color: C.faint,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span aria-hidden style={{ fontSize: 14, color: C.body }}>{collapsed ? "»" : "«"}</span>
        {!collapsed && <span>Collapse</span>}
      </button>

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
              alignItems: collapsed ? "center" : "flex-start",
              justifyContent: collapsed ? "center" : "flex-start",
              gap: 10,
              padding: collapsed ? "10px 0" : "9px 10px",
              marginBottom: 2,
              borderRadius: 4,
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
                width: 22,
                height: 22,
                display: "grid",
                placeItems: "center",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: 700,
                color: on ? "#fff" : C.faint,
                background: on ? C.blue : C.hairline,
              }}
            >
              {it.mark}
            </span>
            {!collapsed && (
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, fontWeight: on ? 600 : 500 }}>
                  {it.label}
                </span>
                <span style={{ display: "block", marginTop: 2, fontSize: 11.5, color: C.faint, lineHeight: 1.45 }}>
                  {it.note}
                </span>
              </span>
            )}
          </Link>
        );
      })}

      {!collapsed && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.hairline}` }}>
          <div style={{ padding: "0 10px", fontSize: 11, fontWeight: 600, letterSpacing: "0.4px", color: C.ghost, textTransform: "uppercase" }}>
            Quick links
          </div>
          <a
            href={NAVIGATOR_URL}
            target="_blank"
            rel="noreferrer"
            style={{ display: "block", padding: "7px 10px", fontSize: 13, color: C.blue }}
          >
            Employee Navigator &#8599;
          </a>
          {manager?.calendly && (
            <a
              href={manager.calendly}
              target="_blank"
              rel="noreferrer"
              style={{ display: "block", padding: "7px 10px", fontSize: 13, color: C.blue }}
            >
              Book time with {manager.name.split(" ")[0]} &#8599;
            </a>
          )}
          {manager?.email && (
            <a
              href={`mailto:${manager.email}`}
              style={{ display: "block", padding: "7px 10px", fontSize: 13, color: C.blue }}
            >
              {manager.email}
            </a>
          )}
        </div>
      )}
    </nav>
  );
}
