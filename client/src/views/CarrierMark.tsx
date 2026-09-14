import { brandOf } from "@/lib/carrier-logos";

interface Props {
  name: string;
  /** Height of the mark in pixels; a logo keeps its own proportions within it. */
  size?: number;
  /** Show the carrier's name beside the mark. */
  withName?: boolean;
  /** Text size for the name. */
  fontSize?: number;
  color?: string;
}

/**
 * A carrier's icon: a rounded tile in the carrier's brand colour with a short
 * mark, drawn by the system so every carrier reads the same way at any size.
 * Sits inline beside the carrier's name in a grid row, a plan card, or a heading.
 */
export default function CarrierMark({ name, size = 22, withName = true, fontSize = 13, color }: Props) {
  const brand = brandOf(name);
  const mark = (
    <span
      aria-hidden={withName}
      title={withName ? undefined : name}
      style={{
        display: "inline-grid",
        placeItems: "center",
        flex: "none",
        height: size,
        minWidth: size,
        padding: `0 ${Math.round(size * 0.2)}px`,
        borderRadius: Math.round(size * 0.26),
        background: `linear-gradient(135deg, ${brand.bg} 0%, ${brand.bg} 70%, rgba(255,255,255,0.18) 100%), ${brand.bg}`,
        boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.12)",
        color: brand.fg,
        fontSize: Math.round(size * (brand.short.length > 2 ? 0.36 : 0.44)),
        fontWeight: 700,
        letterSpacing: "0.2px",
        lineHeight: 1,
        fontFamily: "Sora, Manrope, -apple-system, sans-serif",
      }}
    >
      {brand.short}
    </span>
  );
  if (!withName) return mark;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.36), minWidth: 0 }}>
      {mark}
      <span style={{ fontSize, color, whiteSpace: "nowrap" }}>{name}</span>
    </span>
  );
}
