import type { CSSProperties } from "react";

/** Employee Navigator chrome — the palette the design settled on. */
export const C = {
  page: "#eef1f2",
  card: "#fff",
  border: "#dfe3e6",
  hairline: "#eef1f2",
  rule: "#e6e9eb",
  ink: "#333",
  body: "#5c6368",
  muted: "#6b7276",
  faint: "#8b9296",
  ghost: "#a0a7ab",
  blue: "#2166cd",
  blueInk: "#17479a",
  blueTint: "#eaf1fc",
  blueEdge: "#cadcf6",
  orange: "#e8781a",
  orangeInk: "#c2631a",
  green: "#1e7e34",
  greenTint: "#eaf6ec",
  greenEdge: "#c7e6cd",
  amber: "#8a6d1f",
  amberTint: "#fdf6e3",
  amberEdge: "#ecdcae",
  red: "#a3241c",
  redTint: "#fdf0ef",
  redEdge: "#f0c8c4",
  inputEdge: "#b6bfc4",
  zebra: "#fafbfc",
  /** A dark stripe — a grid's header row, a small round badge. */
  headerBg: "#202429",
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
