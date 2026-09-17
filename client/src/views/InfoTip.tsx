import { C } from "@/lib/ui";

/**
 * The one small ⓘ used everywhere on the site: a 14px circle-i beside a
 * label, the explanation in a bubble on hover and on keyboard focus (the
 * bubble is `.info-tip` in styles.css), and read out as the icon's label.
 * `place` puts the bubble below the icon, hanging left, for a spot near
 * the top of a panel - a table header - where a bubble above would be cut off.
 */
export default function InfoTip({ text, color, place }: { text: string; color?: string; place?: "above" | "below" }) {
  return (
    <span
      className="info-tip"
      tabIndex={0}
      role="img"
      aria-label={text}
      data-tip={text}
      data-place={place || "above"}
      style={{ color: color || C.faint }}
      onClick={(e) => e.stopPropagation()}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    </span>
  );
}
