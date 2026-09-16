import { brandOf } from "@/lib/carrier-logos";
import { websiteOf } from "@/lib/carrier-sites";
import { C } from "@/lib/ui";

interface Props {
  name: string;
  /** Height of the mark in pixels; a logo keeps its own proportions within it. */
  size?: number;
  /** Show the carrier's name beside the mark. */
  withName?: boolean;
  /** Text size for the name. */
  fontSize?: number;
  color?: string;
  /** Link the name to the carrier's or TPA's main website, where one is on file (the default). */
  link?: boolean;
}

/**
 * A carrier's icon: a rounded tile in the carrier's brand colour with a short
 * mark, drawn by the system so every carrier reads the same way at any size.
 * Sits inline beside the carrier's name in a grid row, a plan card, or a heading.
 * The name links to the carrier's or TPA's main website, with a small
 * website icon after it, wherever the site is on file.
 */
export default function CarrierMark({ name, size = 22, withName = true, fontSize = 13, color, link = true }: Props) {
  const brand = brandOf(name);
  const site = link ? websiteOf(name) : null;
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
  const label = <span style={{ fontSize, color, whiteSpace: "nowrap" }}>{name}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.36), minWidth: 0 }}>
      {mark}
      {site ? (
        <a
          href={site}
          target="_blank"
          rel="noopener noreferrer"
          title={`Visit ${name}'s website`}
          aria-label={`${name} website (opens in a new tab)`}
          // A grid row opens the plan card on click; the link must not.
          onClick={(e) => e.stopPropagation()}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none", color: "inherit", minWidth: 0 }}
        >
          {label}
          <svg width={Math.max(11, Math.round(fontSize * 0.85))} height={Math.max(11, Math.round(fontSize * 0.85))} viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "none" }}>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </svg>
        </a>
      ) : (
        label
      )}
    </span>
  );
}
