import type { ReactNode } from "react";
import { costSplit, fmtDed, money0, type MarketPlan, type TierKey } from "@/lib/model";
import { C, chip, linkBtn, num, panel } from "@/lib/ui";
import type { RecommendedPick, Recommendations as Rec } from "@/lib/chat";
import { carrierOf, fundingOf } from "@/views/PlanCard";
import CarrierMark from "@/views/CarrierMark";

/**
 * "Recommended for you": the assistant's picks, on the Medical Plans page
 * rather than in the chat. For each carrier that quoted, three cards —
 * Lower Cost, Best Fit, Richer Benefits — each with the plan's own figures
 * at the group's enrollment and the applied contribution, the assistant's
 * one line on why, and the same heart and plus the grid rows carry. The
 * pick to start with is marked. A card opens the plan's full card; "Show in
 * grid" scrolls to its row. The conversation the picks came from is a
 * click away for follow-ups; asking again replaces the set.
 */

const TIER_LABEL: Record<RecommendedPick["tier"], string> = { lower_cost: "Lower Cost", best_fit: "Best Fit", richer_benefits: "Richer Benefits" };
const TIER_ORDER: RecommendedPick["tier"][] = ["lower_cost", "best_fit", "richer_benefits"];

interface Props {
  rec: Rec;
  plans: MarketPlan[];
  applied: Record<TierKey, number>;
  counts: Record<TierKey, number>;
  enrolled: number;
  selected: Record<string, boolean>;
  heartBlocked: (p: MarketPlan) => boolean;
  heartTitle: (p: MarketPlan) => string;
  onToggleHeart: (plan: string) => void;
  inProposal: (plan: string) => boolean;
  compareFull: boolean;
  onToggleCompare: (plan: string) => void;
  /** Open the plan's full card. */
  onOpen: (plan: string) => void;
  /** Scroll the grid to the plan's row. */
  onShowInGrid: (plan: string) => void;
  /** Open the conversation the picks came from. */
  onRefine: () => void;
  /** Ask for a fresh set. */
  onAskAgain: () => void;
}

export default function Recommendations({ rec, plans, applied, counts, enrolled, selected, heartBlocked, heartTitle, onToggleHeart, inProposal, compareFull, onToggleCompare, onOpen, onShowInGrid, onRefine, onAskAgain }: Props) {
  // A pick is only as good as the quote behind it: one whose option is no
  // longer on the grid (a re-read proposal, a withdrawn plan) is left out.
  const resolved = rec.picks
    .map((pick) => ({ pick, p: plans.find((x) => (x.optionId || "").toUpperCase() === pick.optionId.toUpperCase()) }))
    .filter((x): x is { pick: RecommendedPick; p: MarketPlan } => !!x.p);
  if (!resolved.length) return null;
  const carriers: string[] = [];
  for (const { pick } of resolved) if (!carriers.includes(pick.carrier)) carriers.push(pick.carrier);
  const start = resolved.find((x) => rec.startWith && x.pick.optionId.toUpperCase() === rec.startWith.toUpperCase()) || null;
  const when = new Date(rec.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <section id="recommendations" className="panel anchor noprint" aria-labelledby="recommendations-title" style={{ ...panel, padding: "16px 18px 18px", marginBottom: 18, borderLeft: `4px solid ${C.navy}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 7, background: C.navy, color: C.teal, flex: "none" }} aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
              <path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
            </svg>
          </span>
          <h2 id="recommendations-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: C.navy, lineHeight: 1.2 }}>
            Recommended For You
          </h2>
          <span style={{ fontSize: 12.5, color: C.faint }}>From the assistant · {when}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" onClick={onRefine} style={{ ...chip(false), fontWeight: 600, color: C.blue }} title="Open the conversation these came from and tell the assistant what matters to you">
            Refine In Chat
          </button>
          <button type="button" onClick={onAskAgain} style={{ ...chip(false), fontWeight: 600 }} title="Ask the assistant for a fresh set of picks">
            Ask Again
          </button>
        </div>
      </div>
      {rec.summary && <p style={{ margin: "10px 0 0", fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>{rec.summary}</p>}
      {start && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 8px", marginTop: 8, padding: "8px 12px", background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 6, fontSize: 13.5, color: C.ink, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 700, color: C.blueInk, whiteSpace: "nowrap" }}>Start with {start.pick.optionId}</span>
          <span>
            {start.p.plan}
            {rec.startWithReason ? ` — ${rec.startWithReason}` : ""}
          </span>
        </div>
      )}

      {carriers.map((carrier) => {
        const picks = resolved.filter((x) => x.pick.carrier === carrier).sort((a, b) => TIER_ORDER.indexOf(a.pick.tier) - TIER_ORDER.indexOf(b.pick.tier));
        return (
          <div key={carrier} style={{ marginTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <CarrierMark name={carrierOf(picks[0].p)} size={22} fontSize={14} color={C.ink} />
              <span style={{ fontSize: 12, color: C.faint }}>{fundingOf(picks[0].p)}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
              {picks.map(({ pick, p }) => (
                <PickCard
                  key={pick.optionId}
                  pick={pick}
                  p={p}
                  isStart={!!start && start.pick.optionId === pick.optionId}
                  applied={applied}
                  counts={counts}
                  enrolled={enrolled}
                  heart={!!selected[p.plan]}
                  heartBlocked={heartBlocked(p)}
                  heartTitle={heartTitle(p)}
                  onToggleHeart={() => onToggleHeart(p.plan)}
                  added={inProposal(p.plan)}
                  compareFull={compareFull}
                  onToggleCompare={() => onToggleCompare(p.plan)}
                  onOpen={() => onOpen(p.plan)}
                  onShowInGrid={() => onShowInGrid(p.plan)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PickCard({ pick, p, isStart, applied, counts, enrolled, heart, heartBlocked, heartTitle, onToggleHeart, added, compareFull, onToggleCompare, onOpen, onShowInGrid }: { pick: RecommendedPick; p: MarketPlan; isStart: boolean; applied: Record<TierKey, number>; counts: Record<TierKey, number>; enrolled: number; heart: boolean; heartBlocked: boolean; heartTitle: string; onToggleHeart: () => void; added: boolean; compareFull: boolean; onToggleCompare: () => void; onOpen: () => void; onShowInGrid: () => void }) {
  const sp = costSplit(p, applied, counts);
  const best = pick.tier === "best_fit";
  const stat = (label: string, value: ReactNode) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, color: C.faint, whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, ...num }}>{value}</div>
    </div>
  );
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`${TIER_LABEL[pick.tier]}: ${pick.optionId} ${p.plan}. Open every detail.`}
      className="rowlink"
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px 10px", background: heart ? C.blueTint : C.card, border: `1px solid ${isStart ? C.blue : C.border}`, boxShadow: isStart ? `0 0 0 2px ${C.blueEdge}` : undefined, borderRadius: 8, cursor: "pointer", textAlign: "left" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.2px", color: best ? C.onColor : C.blueInk, background: best ? C.blue : C.blueTint, border: `1px solid ${best ? C.blue : C.blueEdge}`, borderRadius: 10, padding: "2px 9px", whiteSpace: "nowrap" }}>{TIER_LABEL[pick.tier]}</span>
        {isStart && <span style={{ fontSize: 11.5, fontWeight: 700, color: C.blueInk, whiteSpace: "nowrap" }}>★ Start here</span>}
      </div>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: C.onColor, background: C.navy, borderRadius: 6, padding: "1px 7px", ...num }}>{pick.optionId}</span>
          <span style={{ fontSize: 11.5, color: C.faint }}>{p.type && p.type !== p.label ? p.type : ""}</span>
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: C.ink, lineHeight: 1.3, marginTop: 4 }}>{p.plan}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 10px", paddingTop: 8, borderTop: `1px solid ${C.hairline}` }}>
        {stat("Deductible", fmtDed(p.ded))}
        {stat("OOP max", p.oop == null ? "—" : money0(p.oop))}
        {stat("Total monthly bill", p.monthly == null ? "—" : money0(p.monthly))}
        {stat("Your company pays", sp ? money0(sp.er) : "—")}
      </div>
      <div style={{ fontSize: 11.5, color: C.faint, ...num }}>
        {sp && enrolled ? `Employees pay ${money0(sp.ee / enrolled)} a month on average` : "Monthly figures at your enrollment"}
      </div>
      {pick.reason && <div style={{ fontSize: 12.5, color: C.body, lineHeight: 1.5 }}>{pick.reason}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto", paddingTop: 4 }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <button type="button" onClick={onToggleHeart} disabled={heartBlocked} title={heartTitle} aria-label={heart ? `Remove ${p.plan} from favorites` : `Add ${p.plan} to favorites`} style={{ ...chip(heart), padding: "5px 10px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 5, color: heart ? C.onColor : heartBlocked ? C.ghost : C.red, background: heart ? C.red : C.card, border: `1px solid ${heart ? C.red : heartBlocked ? C.hairline : C.redEdge}` }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill={heart ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 7.9 3.6 4.5 7 4.5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 15.9 12 20.5 12 20.5Z" />
          </svg>
          {heart ? "Favorited" : "Favorite"}
        </button>
        <button type="button" onClick={onToggleCompare} disabled={!added && compareFull} aria-label={added ? `Remove ${p.plan} from the comparison` : `Add ${p.plan} to the comparison`} title={added ? "Remove from compare" : compareFull ? "Up to 4 plans side by side — remove one first" : "Add to compare"} style={{ ...chip(added), padding: "5px 10px", fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 5, ...(added ? { background: C.green, border: `1px solid ${C.green}` } : { color: !added && compareFull ? C.ghost : C.blue }) }}>
          {added ? "✓ Comparing" : "+ Compare"}
        </button>
        <button type="button" onClick={onShowInGrid} style={{ ...linkBtn, fontSize: 12.5, fontWeight: 600, marginLeft: "auto", whiteSpace: "nowrap" }} aria-label={`Show ${p.plan} in the grid`}>
          Show in grid ↓
        </button>
      </div>
    </div>
  );
}
