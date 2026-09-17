import { useMemo } from "react";
import { marketPlans, type AccountManager, type Group, type KennionData, type TierContribution, type TierKey } from "@/lib/model";
import OptionsGrid from "@/views/OptionsGrid";

interface Props {
  data: KennionData;
  g: Group;
  totals: { total: number; enrolled: number };
  selected: Record<string, boolean>;
  /** Shown on the printed proposal's footer. */
  manager: AccountManager | null;
  /** Today's employer contribution by tier, and the employer's own editable 2027 figures. */
  contribution: TierContribution[];
  contributionValues: Record<TierKey, number>;
  contributionChanged: boolean;
  onContributionApply: (values: Record<TierKey, number>) => void;
  onContributionReset: () => void;
  onToggleSelected: (plan: string) => void;
  /** Whether the assistant is on for this group: the Get Plan Recommendations button needs it. */
  assistantOn?: boolean;
}

/**
 * New 2027 Medical Options: the employer sets a monthly budget per tier, and
 * one grid of every plan from every carrier shows what each would cost them
 * at that budget, and in total. The way a defined-contribution (ICHRA)
 * comparison reads - the employer in the driver's seat for monthly spend.
 */
export default function Options({
  data,
  g,
  totals,
  selected,
  manager,
  contribution,
  contributionValues,
  contributionChanged,
  onContributionApply,
  onContributionReset,
  onToggleSelected,
  assistantOn = false,
}: Props) {
  const plans = useMemo(() => marketPlans(data, g), [data, g]);

  return (
    <div>
      <OptionsGrid
        g={g}
        assistantOn={assistantOn}
        plans={plans}
        totals={totals}
        selected={selected}
        onToggleSelected={onToggleSelected}
        manager={manager}
        contribution={contribution}
        applied={contributionValues}
        appliedChanged={contributionChanged}
        onApply={onContributionApply}
        onReset={onContributionReset}
      />
    </div>
  );
}

