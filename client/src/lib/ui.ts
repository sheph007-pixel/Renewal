import type { CSSProperties } from "react";

/**
 * Employee Navigator chrome — the palette the design settled on. Every value
 * is a CSS custom property, defined for light in `:root` and overridden for
 * dark under `[data-theme="dark"]` (styles.css) — so light/dark is one
 * palette swap, not two copies of every screen that uses it.
 */
export const C = {
  page: "var(--page)",
  card: "var(--card)",
  border: "var(--border)",
  hairline: "var(--hairline)",
  rule: "var(--rule)",
  ink: "var(--ink)",
  body: "var(--body)",
  muted: "var(--muted)",
  faint: "var(--faint)",
  ghost: "var(--ghost)",
  blue: "var(--blue)",
  blueInk: "var(--blue-ink)",
  blueTint: "var(--blue-tint)",
  blueEdge: "var(--blue-edge)",
  orange: "var(--orange)",
  orangeInk: "var(--orange-ink)",
  green: "var(--green)",
  greenTint: "var(--green-tint)",
  greenEdge: "var(--green-edge)",
  amber: "var(--amber)",
  amberTint: "var(--amber-tint)",
  amberEdge: "var(--amber-edge)",
  red: "var(--red)",
  redTint: "var(--red-tint)",
  redEdge: "var(--red-edge)",
  inputEdge: "var(--input-edge)",
  zebra: "var(--zebra)",
  /** A dark stripe — a grid's header row, a small round badge — that stays
   *  dark in both themes rather than flipping with the page around it. */
  headerBg: "var(--header-bg)",
  /** Always white / always near-black, regardless of theme — text on a
   *  solidly-coloured chip (a blue button, a green badge) never flips. */
  onColor: "#fff",
} as const;

export const panel: CSSProperties = {
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
};

export const primaryBtn: CSSProperties = {
  padding: "9px 20px",
  fontSize: 14,
  fontWeight: 500,
  color: C.onColor,
  background: C.blue,
  border: `1px solid ${C.blue}`,
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const smallPrimaryBtn: CSSProperties = {
  ...primaryBtn,
  padding: "8px 16px",
  fontSize: 13.5,
};

export const linkBtn: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  fontSize: 13.5,
  color: C.blue,
  cursor: "pointer",
};

export const textInput: CSSProperties = {
  padding: "9px 11px",
  fontSize: 14,
  color: C.ink,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: 4,
  outline: "none",
  background: C.card,
};

export const num: CSSProperties = { fontVariantNumeric: "tabular-nums" };

export const sectionHead: CSSProperties = {
  margin: "26px 0 12px",
  paddingBottom: 9,
  borderBottom: `1px solid ${C.border}`,
};

export const h2: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 600, color: C.ink };

export const th: CSSProperties = {
  padding: "12px 8px 11px",
  fontSize: 13,
  fontWeight: 600,
  color: C.ink,
  borderBottom: `1px solid ${C.border}`,
};

export const td: CSSProperties = {
  padding: "9px 8px",
  borderBottom: `1px solid ${C.hairline}`,
};

/** Filter/segmented control button. */
export const chip = (on: boolean): CSSProperties => ({
  padding: "7px 13px",
  fontSize: 13,
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
  ...(on
    ? { color: C.onColor, background: C.blue, border: `1px solid ${C.blue}`, fontWeight: 500 }
    : { color: C.body, background: C.card, border: `1px solid ${C.inputEdge}` }),
});

/** Coloured status pill: [foreground, background, border]. */
export const pill = (fg: string, bg: string, bd: string): CSSProperties => ({
  fontSize: 11.5,
  fontWeight: 500,
  whiteSpace: "nowrap",
  color: fg,
  background: bg,
  border: `1px solid ${bd}`,
  borderRadius: 3,
  padding: "3px 8px",
});

export const Logo = "/assets/kennion-logo.png";
