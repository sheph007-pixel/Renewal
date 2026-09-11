import { useMemo } from "react";
import { hasDirectQuote, marketPlans, type Group, type KennionData, type TierContribution, type TierKey } from "@/lib/model";
import { C, h2, panel } from "@/lib/ui";
import Link from "@/lib/Link";
import OptionsGrid from "@/views/OptionsGrid";

interface Props {
  data: KennionData;
  g: Group;
  totals: { total: number; enrolled: number };
  selected: Record<string, boolean>;
  /** Where the shortlist is reviewed and sent — its own page now. */
  signUpHref: string;
  /** Today's employer contribution by tier, and the employer's own editable 2027 figures. */
  contribution: TierContribution[];
  contributionValues: Record<TierKey, number>;
  contributionChanged: boolean;
  onContributionApply: (values: Record<TierKey, number>) => void;
  onContributionReset: () => void;
  onToggleSelected: (plan: string) => void;
}

/**
 * New 2027 Medical Options: the employer sets a monthly budget per tier, and
 * one grid of every plan from every carrier shows what each would cost them
 * at that budget, and in total. The way a defined-contribution (ICHRA)
 * comparison reads — the employer in the driver's seat for monthly spend.
 */
export default function Options({
  data,
  g,
  totals,
  selected,
  signUpHref,
  contribution,
  contributionValues,
  contributionChanged,
  onContributionApply,
  onContributionReset,
  onToggleSelected,
}: Props) {
  const plans = useMemo(() => marketPlans(data, g), [data, g]);
  const direct = hasDirectQuote(data, g);
  const short = plans.filter((p) => selected[p.plan]);

  return (
    <div>
      <OptionsGrid
        g={g}
        plans={plans}
        totals={totals}
        selected={selected}
        onToggleSelected={onToggleSelected}
        direct={direct}
        contribution={contribution}
        applied={contributionValues}
        appliedChanged={contributionChanged}
        onApply={onContributionApply}
        onReset={onContributionReset}
      />

      <div className="panel noprint" style={{ ...panel, marginTop: 24, padding: "18px 20px" }}>
        <h2 style={{ ...h2, margin: "0 0 4px" }}>Ready to move forward?</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          {short.length
            ? `${short.length} plan${short.length > 1 ? "s" : ""} on your shortlist. Review it, add a note, and send it in on Sign Up.`
            : "Heart any plan above to add it to your shortlist. Nothing is binding — it just tells us what to price for you."}
        </p>
        <Link
          href={signUpHref}
          style={{
            display: "inline-block",
            padding: "9px 18px",
            fontSize: 13.5,
            fontWeight: 500,
            color: "#fff",
            background: C.blue,
            border: `1px solid ${C.blue}`,
            borderRadius: 4,
            textDecoration: "none",
          }}
        >
          {short.length ? "Review your shortlist →" : "Go to Sign Up →"}
        </Link>
      </div>
    </div>
  );
}

