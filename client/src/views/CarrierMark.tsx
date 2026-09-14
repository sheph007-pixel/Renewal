import { brandOf, logoUrl, useCarrierLogos } from "@/lib/carrier-logos";

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
 * A carrier's mark: its logo when one is on file, otherwise a lettered badge
 * in the carrier's colour. Sits inline beside the carrier's name in a grid
 * row, a plan card, or a heading.
 */
export default function CarrierMark({ name, size = 22, withName = true, fontSize = 13, color }: Props) {
  const { has, version } = useCarrierLogos();
  const brand = brandOf(name);
  const mark = has(name) ? (
    <img src={logoUrl(name, version)} alt={name} style={{ height: size, maxWidth: size * 4, width: "auto", objectFit: "contain", display: "block", flex: "none" }} />
  ) : (
    <span
      aria-hidden={withName}
      title={withName ? undefined : name}
      style={{ display: "inline-grid", placeItems: "center", flex: "none", height: size, minWidth: size, padding: `0 ${Math.round(size * 0.22)}px`, borderRadius: Math.round(size * 0.24), background: brand.bg, color: brand.fg, fontSize: Math.round(size * 0.42), fontWeight: 700, letterSpacing: "0.3px", lineHeight: 1 }}
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
