import { brandOf } from "@/lib/carrier-logos";
import { findADoctorOf, websiteOf } from "@/lib/carrier-sites";
import { C } from "@/lib/ui";
import { useNarrow } from "@/lib/narrow";

interface Props {
  name: string;
  /** Height of the mark in pixels; a logo keeps its own proportions within it. */
  size?: number;
  /** Show the carrier's name beside the mark. */
  withName?: boolean;
  /** Text size for the name. */
  fontSize?: number;
  color?: string;
  /**
   * Link the name to the carrier's or TPA's main website, where one is on
   * file. Off by default: a grid row opens the plan card on click, and a
   * second link on the same row would compete with it. The plan card
   * carries the website as its own link (`CarrierSiteLink`).
   */
  link?: boolean;
}

/** The small website glyph that marks an outbound carrier link. */
export function GlobeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "none" }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

/**
 * The one place a client leaves BenSync for the carrier's or TPA's own
 * website: a small labelled button on the plan card that opens a new tab -
 * an icon alone does not read as clickable, so it keeps a short "Website"
 * label rather than spelling out the carrier's name (the header row it sits
 * in is tight). The options modal gives its own close button a clear strip
 * above the card, so this can sit flush in the card's top-right corner
 * without the two overlapping. Nothing when no site is on file for the name.
 */
export function CarrierSiteLink({ name, fontSize = 12.5 }: { name: string; fontSize?: number }) {
  const narrow = useNarrow();
  const site = websiteOf(name);
  if (!site) return null;
  return (
    <a
      href={site}
      target="_blank"
      rel="noopener noreferrer"
      className="noprint"
      title={`Visit ${name}'s website`}
      aria-label={`Visit ${name}'s website (opens in a new tab)`}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flex: "none",
        padding: narrow ? "10px 13px" : "5px 11px",
        borderRadius: 999,
        border: `1px solid ${C.blueEdge}`,
        background: C.blueTint,
        fontSize,
        fontWeight: 600,
        color: C.blueInk,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      <GlobeIcon size={Math.round(fontSize * 1.1)} />
      Website
    </a>
  );
}

/** A small magnifying-glass glyph for the "Find A Doctor" link. */
function SearchIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "none" }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

/**
 * The carrier's or TPA's public provider-search tool, alongside its website
 * link - "is my doctor in network?" is the very next question after "what's
 * their website." Nothing when no directory is on file for the name.
 */
export function FindADoctorLink({ name, fontSize = 12.5 }: { name: string; fontSize?: number }) {
  const narrow = useNarrow();
  const url = findADoctorOf(name);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="noprint"
      title={`Find a doctor in ${name}'s network`}
      aria-label={`Find a doctor in ${name}'s network (opens in a new tab)`}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flex: "none",
        padding: narrow ? "10px 13px" : "5px 11px",
        borderRadius: 999,
        border: `1px solid ${C.greenEdge}`,
        background: C.greenTint,
        fontSize,
        fontWeight: 600,
        color: C.green,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      <SearchIcon size={Math.round(fontSize * 1.1)} />
      Find A Doctor
    </a>
  );
}

/**
 * A carrier's icon: a rounded tile in the carrier's brand colour with a short
 * mark, drawn by the system so every carrier reads the same way at any size.
 * Sits inline beside the carrier's name in a grid row, a plan card, or a heading.
 * With `link`, the name goes to the carrier's or TPA's main website with a
 * small website icon after it, where the site is on file.
 */
export default function CarrierMark({ name, size = 22, withName = true, fontSize = 13, color, link = false }: Props) {
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
        fontFamily: '"Google Sans Flex", -apple-system, sans-serif',
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
          <span style={{ display: "inline-flex", color: C.blue }}>
            <GlobeIcon size={Math.max(11, Math.round(fontSize * 0.85))} />
          </span>
        </a>
      ) : (
        label
      )}
    </span>
  );
}
