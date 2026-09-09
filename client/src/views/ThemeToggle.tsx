import { useEffect, useState } from "react";
import { applyTheme, loadTheme, saveTheme, type Theme } from "@/lib/theme";
import { C } from "@/lib/ui";

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.2A8.5 8.5 0 1 1 9.8 4a6.7 6.7 0 0 0 10.2 10.2Z" />
    </svg>
  );
}

/** The one shared switch, so a change here changes what every button on the site looks like. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

/**
 * Light or dark, for the whole site — not just this tab's chrome. A row like
 * every other Links row, so it sits where a person already looks for a
 * setting rather than living in some separate preferences screen no one
 * would find.
 */
export default function ThemeToggle({
  theme,
  onToggle,
  compact,
  bordered,
}: {
  theme: Theme;
  onToggle: () => void;
  /** An icon-only button, no label — the collapsed rail, or a header bar. */
  compact?: boolean;
  /** A bordered square, matching the other icon buttons in a page header. */
  bordered?: boolean;
}) {
  const label = theme === "dark" ? "Light Mode" : "Dark Mode";
  if (compact) {
    return (
      <button
        onClick={onToggle}
        title={label}
        style={{
          display: "grid",
          placeItems: "center",
          width: bordered ? 32 : "100%",
          height: bordered ? 32 : undefined,
          padding: bordered ? 0 : "8px 0",
          background: "none",
          border: bordered ? `1px solid ${C.border}` : "none",
          borderRadius: bordered ? 6 : 0,
          color: C.body,
          cursor: "pointer",
        }}
      >
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </button>
    );
  }
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "8px 14px",
        width: "100%",
        fontSize: 13,
        fontWeight: 500,
        color: C.body,
        background: "none",
        border: "none",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none", color: C.faint }}>
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  );
}
