import { useEffect, useState } from "react";
import { money, money0, type TierContribution, type TierKey } from "@/lib/model";
import { C, h2, num, panel } from "@/lib/ui";

interface Props {
  /** Today's employer contribution, one figure per tier — always the read basis. */
  tiers: TierContribution[];
  /**
   * Present only on the editable card: the employer's own dollar-per-tier for
   * next year, defaulted to today's figures, and a way to change or reset them.
   */
  editable?: {
    values: Record<TierKey, number>;
    onChange: (key: TierKey, value: number) => void;
    onReset: () => void;
    changed: boolean;
  };
}

const TIER_LABEL: Record<TierKey, string> = {
  EE: "Employee Only",
  ES: "Employee + Spouse",
  EC: "Employee + Children",
  FAM: "Employee + Family",
};

/** A single tier's dollar figure — a plain number when locked, an input when not. */
function TierBox({
  t,
  value,
  onChange,
}: {
  t: TierContribution;
  value: number | null;
  onChange?: (v: number) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  // While the field is focused, what's typed is the source of truth — a
  // round trip through the parent's number would strip a trailing "." mid
  // keystroke. Once it isn't focused, an outside change (Reset, a different
  // group loading) is free to overwrite it.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value == null ? "" : String(value));
  }, [value, focused]);
  return (
    <div style={{ flex: "1 1 130px", minWidth: 130 }}>
      <div style={{ fontSize: 12, color: C.faint, marginBottom: 6 }}>{TIER_LABEL[t.key]}</div>
      {onChange ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14, color: C.faint }}>$</span>
          <input
            value={text}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, "");
              setText(v);
              const n = +v;
              if (v !== "" && !isNaN(n)) onChange(n);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            inputMode="decimal"
            aria-label={`Employer contribution, ${TIER_LABEL[t.key]}`}
            style={{
              width: "100%",
              padding: "8px 9px",
              fontSize: 15,
              fontWeight: 600,
              color: C.ink,
              border: `1px solid ${C.inputEdge}`,
              borderRadius: 4,
              outline: "none",
              ...num,
            }}
          />
        </div>
      ) : (
        <div style={{ fontSize: 19, fontWeight: 600, color: t.count ? C.ink : C.faint, ...num }}>
          {value == null ? "—" : money0(value)}
        </div>
      )}
      <div style={{ marginTop: 3, fontSize: 11.5, color: C.faint }}>
        {t.count ? `${t.count} enrolled` : "none enrolled"}
      </div>
    </div>
  );
}

/**
 * What the employer puts in, per tier — the figure a group actually wants
 * first, before any plan detail: what am I spending, and can I keep spending
 * it? Current Medical Plans shows it locked, read off real rates and
 * enrollment. New 2027 Medical Options shows the same figure unlocked,
 * defaulted to today's numbers, so keeping spend flat is the default and
 * changing it is a deliberate choice with its cost shown immediately.
 */
export default function ContributionCard({ tiers, editable }: Props) {
  const annual = editable
    ? tiers.reduce((sum, t) => sum + (editable.values[t.key] || 0) * t.count, 0) * 12
    : null;
  const monthly = annual == null ? null : annual / 12;

  return (
    <div style={{ ...panel, padding: "18px 20px", marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h2 style={{ ...h2, fontSize: 15.5 }}>Employer Contribution</h2>
        {editable ? (
          editable.changed && (
            <button
              onClick={editable.onReset}
              className="noprint"
              style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}
            >
              Reset to what you spend today
            </button>
          )
        ) : (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.3px",
              color: C.faint,
              textTransform: "uppercase",
              padding: "3px 8px",
              border: `1px solid ${C.border}`,
              borderRadius: 3,
            }}
          >
            From your current plan
          </span>
        )}
      </div>

      <p style={{ margin: "6px 0 14px", fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>
        {editable
          ? "What you'd put toward each tier for 2027, per enrolled employee per month. Starts equal to what you spend today — change any figure to see the cost."
          : "What you put toward each tier today, per enrolled employee per month, averaged across your current plans."}
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
        {tiers.map((t) => (
          <TierBox
            key={t.key}
            t={t}
            value={editable ? editable.values[t.key] : t.er}
            onChange={editable ? (v) => editable.onChange(t.key, v) : undefined}
          />
        ))}
      </div>

      {editable && monthly != null && (
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: `1px solid ${C.hairline}`,
            display: "flex",
            flexWrap: "wrap",
            gap: 24,
            alignItems: "baseline",
          }}
        >
          <div>
            <div style={{ fontSize: 11.5, color: C.faint }}>Estimated employer spend</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, ...num }}>{money(monthly)} / mo</div>
          </div>
          <div>
            <div style={{ fontSize: 11.5, color: C.faint }}>Per year</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.body, ...num }}>{money0(annual!)}</div>
          </div>
          <div style={{ fontSize: 11.5, color: C.faint, maxWidth: 320, lineHeight: 1.5 }}>
            At today&rsquo;s enrollment — {tiers.reduce((n, t) => n + t.count, 0)} employees. The plan you actually
            pick still sets the total premium; this is only the employer&rsquo;s share of it.
          </div>
        </div>
      )}

      {!editable && !tiers.some((t) => t.actual) && tiers.some((t) => t.count) && (
        <div style={{ marginTop: 12, fontSize: 11.5, color: C.faint, lineHeight: 1.5 }}>
          Estimated from a standard employer/employee split until your Employee Navigator contribution
          configuration is loaded — ask your account manager to confirm the real numbers.
        </div>
      )}
    </div>
  );
}
