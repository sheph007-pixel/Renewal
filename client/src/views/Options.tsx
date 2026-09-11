import { useMemo } from "react";
import {
  PROPOSAL_SLOTS,
  fmtDate,
  fmtDed,
  hasDirectQuote,
  marketPlans,
  marketSummary,
  money,
  money0,
  type Group,
  type KennionData,
  type MarketPlan,
  type PlanRow,
  type TierContribution,
  type TierKey,
} from "@/lib/model";
import { C, h2, num, panel, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";
import ContributionCard from "@/views/ContributionCard";
import OptionsGrid from "@/views/OptionsGrid";

/** Sections on this page, in order, for the "On this page" links. */
export const OPTIONS_SECTIONS = [
  { id: "market", label: "Market Summary" },
  { id: "recommends", label: "Kennion Recommends" },
  { id: "all-options", label: "All Options" },
];



interface Props {
  data: KennionData;
  g: Group;
  rows: PlanRow[];
  totals: { total: number; enrolled: number };
  selected: Record<string, boolean>;
  /** Where the shortlist is reviewed and sent — its own page now. */
  signUpHref: string;
  /** Today's employer contribution by tier, and the employer's own editable 2027 figures. */
  contribution: TierContribution[];
  contributionValues: Record<TierKey, number>;
  contributionChanged: boolean;
  onContributionChange: (key: TierKey, value: number) => void;
  onContributionReset: () => void;
  onToggleSelected: (plan: string) => void;
}

export default function Options({
  data,
  g,
  rows,
  totals,
  selected,
  signUpHref,
  contribution,
  contributionValues,
  contributionChanged,
  onContributionChange,
  onContributionReset,
  onToggleSelected,
}: Props) {
  const plans = useMemo(() => marketPlans(data, g), [data, g]);
  const direct = hasDirectQuote(data, g);

  // Proposals on file for this group, slot by slot: what has been quoted and
  // what is still out with a carrier.
  const proposalsOnFile = useMemo(() => {
    const have = new Map((data.proposals || []).map((p) => [p.slot, p]));
    const slots = data.slots?.length ? data.slots : PROPOSAL_SLOTS;
    const quoted = slots.filter((s) => have.has(s)).map((s) => {
      const pr = have.get(s)!;
      return `${s.replace(/^UHC/, "UnitedHealthcare")} (${pr.plans.length} plan${pr.plans.length === 1 ? "" : "s"}, ${fmtDate(pr.effectiveDate || pr.uploadedAt.slice(0, 10))})`;
    });
    const waiting = slots.filter((s) => !have.has(s)).map((s) => s.replace(/^UHC/, "UnitedHealthcare"));
    return { quoted, waiting, any: quoted.length > 0 };
  }, [data.proposals, data.slots]);

  // "Mapped 1-for-1" — each current plan costed on its closest 2027 match at
  // that plan's own tier counts. Deliberately a different figure from the
  // recommendation cards, which put every employee on a single plan. Shared
  // with What's Changing For 2027, so the two pages never disagree.
  const summary = useMemo(() => marketSummary(data, g, rows, totals.total), [data, g, rows, totals.total]);
  const closest = summary.mappedTotal;
  const delta = summary.delta;
  const priced = plans.filter((p) => p.monthly != null);

  const recs = useMemo(() => {
    const mapping = (data.uhc || {}).mapping || [];
    const matched = rows
      .map((r) => {
        const mp = mapping.find((m) => m.currentPlan && r.p.plan.indexOf(m.currentPlan) !== -1);
        return mp ? { uhcPlan: mp.uhcPlan, enrolled: r.p.enrolled || 0 } : null;
      })
      .filter((x): x is { uhcPlan: string; enrolled: number } => x != null)
      .sort((a, b) => b.enrolled - a.enrolled);

    const byCost = priced.slice().sort((a, b) => a.monthly! - b.monthly!);
    const pick: [string, MarketPlan, string][] = [];

    const closestPlan = priced.find((p) => p.plan === matched[0]?.uhcPlan);
    if (closestPlan)
      pick.push([
        "Closest to what you have",
        closestPlan,
        "Same deductible and copay shape as your current plan — the least disruptive move for your members.",
      ]);
    if (byCost[0] && byCost[0] !== closestPlan)
      pick.push([
        "Lowest total cost",
        byCost[0],
        "Cheapest priced option at your exact census. Higher member cost-sharing — worth modeling against your claims.",
      ]);
    const richest = priced.slice().sort((a, b) => +(a.ded ?? 0) - +(b.ded ?? 0))[0];
    if (richest && !pick.some((x) => x[1] === richest))
      pick.push([
        "Richest benefits",
        richest,
        "Lowest deductible on the menu — keeps member out-of-pocket exposure closest to your current plan.",
      ]);
    const surest = plans.find((p) => /Surest/.test(p.carrier));
    if (surest && surest.monthly != null && !pick.some((x) => x[1] === surest))
      pick.push([
        "No deductible",
        surest,
        "Copay-only. Members see the price of every visit before they book — no deductible to meet.",
      ]);
    return pick.slice(0, 4);
  }, [data, rows, plans, priced]);

  const short = plans.filter((p) => selected[p.plan]);

  return (
    <div>
      <ContributionCard
        tiers={contribution}
        editable={{
          values: contributionValues,
          onChange: onContributionChange,
          onReset: onContributionReset,
          changed: contributionChanged,
        }}
      />

      <div
        id="market"
        className="panel anchor"
        style={{
          ...panel,
          marginTop: 16,
          padding: "20px 22px",
          display: "flex",
          flexWrap: "wrap",
          gap: 30,
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div style={{ maxWidth: 660 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: C.ink }}>
            We Shopped The Market For January 1, 2027
          </h2>
          <p
            style={{
              margin: "10px 0 0",
              fontSize: 13.5,
              lineHeight: 1.65,
              color: C.body,
              textWrap: "pretty",
            }}
          >
            Your 2026 program plans end December 31, 2026. We took your census to UnitedHealthcare,
            Surest and Gravie and priced every plan on their menus — {priced.length} options below,
            all costed at your current enrollment so the comparison is apples to apples.
            {!direct &&
              !proposalsOnFile.any &&
              " UnitedHealthcare underwriting for your group is still open, so rates below are indicative: your own current rate level applied to the menu quoted for comparable Kennion groups. Firm rates land here the day they arrive."}
          </p>
          {proposalsOnFile.any && (
            <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, color: C.body }}>
              <strong style={{ fontWeight: 600, color: C.ink }}>Quoted for your group:</strong> {proposalsOnFile.quoted.join(" · ")}. Those rows are marked
              <em> quoted</em> below and are the carrier&rsquo;s own rates for you.
              {proposalsOnFile.waiting.length > 0 && ` Still out: ${proposalsOnFile.waiting.join(", ")}.`}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "14px 22px",
              borderRight: `1px solid ${C.border}`,
              background: C.zebra,
            }}
          >
            <div style={{ fontSize: 12.5, color: C.muted }}>Today</div>
            <div
              style={{
                marginTop: 6,
                fontSize: 22,
                fontWeight: 600,
                color: C.ink,
                letterSpacing: "-0.4px",
                ...num,
              }}
            >
              {money(totals.total)}
            </div>
            <div style={{ fontSize: 12, color: C.faint }}>per month</div>
          </div>
          <div style={{ padding: "14px 22px", background: C.zebra }}>
            <div style={{ fontSize: 12.5, color: C.muted }}>2027, plans mapped 1-for-1</div>
            <div
              style={{
                marginTop: 6,
                fontSize: 22,
                fontWeight: 600,
                color: C.ink,
                letterSpacing: "-0.4px",
                ...num,
              }}
            >
              {closest ? money0(closest) : "In progress"}
            </div>
            <div style={{ fontSize: 12, color: C.faint }}>
              {delta == null
                ? "quotes arriving"
                : `${delta >= 0 ? "+" : "−"}${money0(Math.abs(delta))} / mo vs today${direct ? "" : " (indicative)"}`}
            </div>
          </div>
        </div>
      </div>

      <div id="recommends" className="anchor" style={sectionHead}>
        <h2 style={h2}>Kennion Recommends</h2>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,minmax(314px,1fr))",
          gap: 16,
        }}
      >
        {recs.map(([badge, p, why]) => {
          const dv = p.monthly! - totals.total;
          const on = !!selected[p.plan];
          return (
            <div
              key={badge}
              className="panel"
              style={{ ...panel, display: "flex", flexDirection: "column" }}
            >
              <div
                style={{
                  padding: "11px 18px",
                  borderBottom: `2px solid ${C.orange}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.orangeInk }}>{badge}</span>
                <span style={{ fontSize: 12, color: C.faint }}>{p.carrier}</span>
              </div>
              <div
                style={{
                  padding: "15px 18px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  flex: 1,
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 600, color: C.ink, lineHeight: 1.3 }}>
                  {p.plan}
                </div>
                <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>
                  {fmtDed(p.ded)} deductible ·{" "}
                  {p.oop ? `${money0(p.oop)} OOP max` : "OOP max on quote"} · {p.copays}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    paddingTop: 9,
                    borderTop: `1px solid ${C.hairline}`,
                  }}
                >
                  <span
                    style={{
                      fontSize: 22,
                      fontWeight: 600,
                      color: C.ink,
                      letterSpacing: "-0.4px",
                      ...num,
                    }}
                  >
                    {money0(p.monthly)}
                  </span>
                  <span style={{ fontSize: 12, color: C.faint }}>
                    / mo with all {totals.enrolled} employees on this plan
                  </span>
                </div>
                <div
                  style={{ fontSize: 13, fontWeight: 600, color: dv >= 0 ? C.red : C.green }}
                >
                  {dv >= 0 ? "+" : "−"}
                  {money0(Math.abs(dv))} / mo vs today ({dv >= 0 ? "+" : "−"}
                  {Math.abs(Math.round((dv / totals.total) * 100))}%)
                </div>
                <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>{why}</div>
              </div>
              <div className="noprint" style={{ padding: "0 18px 18px" }}>
                <button
                  onClick={() => onToggleSelected(p.plan)}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    fontSize: 13.5,
                    fontWeight: 500,
                    borderRadius: 4,
                    cursor: "pointer",
                    ...(on
                      ? { background: C.blueTint, border: `1px solid ${C.blue}`, color: C.blue }
                      : { background: C.blue, border: `1px solid ${C.blue}`, color: "#fff" }),
                  }}
                >
                  {on ? "✓ On your shortlist" : "Add to shortlist"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div id="all-options" className="anchor" style={sectionHead}>
        <h2 style={h2}>All 2027 Medical Plan Options</h2>
      </div>
      <OptionsGrid g={g} plans={plans} totals={totals} selected={selected} onToggleSelected={onToggleSelected} direct={direct} />

      {/*
        The shortlist itself, the note, and sending it are Sign Up's job now —
        this is a pointer there, so building a shortlist has somewhere to go.
      */}
      <div className="panel noprint" style={{ ...panel, marginTop: 24, padding: "18px 20px" }}>
        <h2 style={{ ...h2, margin: "0 0 4px" }}>Ready to move forward?</h2>
        <p style={{ margin: "0 0 14px", fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
          {short.length
            ? `${short.length} plan${short.length > 1 ? "s" : ""} on your shortlist. Review it, add a note, and send it in on Sign Up.`
            : "Check any plan above to add it to your shortlist. Nothing is binding — it just tells us what to price for you."}
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
          {short.length ? "Review your shortlist \u2192" : "Go to Sign Up \u2192"}
        </Link>
      </div>
    </div>
  );
}

