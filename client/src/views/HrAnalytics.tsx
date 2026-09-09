import { C, num } from "@/lib/ui";

interface Props {
  eligible?: number;
  enrolled: number;
  /** Employer's share of the monthly premium, 0-100. */
  contributionPct: number;
}

/** Group participation against a typical group's, so a client can read
 *  "we're above/below average" at a glance rather than guess at a raw %. */
const PARTICIPATION_BENCHMARK = 52;
const CONTRIBUTION_BENCHMARK = 68.6;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: "0.3px" }}>
        {label}
      </div>
      <div style={{ marginTop: 2, fontSize: 16, fontWeight: 700, color: C.ink, ...num }}>{value}</div>
      {sub && <div style={{ marginTop: 1, fontSize: 10.5, color: C.faint, ...num }}>{sub}</div>}
    </div>
  );
}

function vsBenchmark(pct: number, benchmark: number) {
  const diff = Math.round((pct - benchmark) * 10) / 10;
  if (diff === 0) return `at the ${benchmark}% benchmark`;
  return `${diff > 0 ? "+" : ""}${diff}pt vs ${benchmark}% benchmark`;
}

/**
 * A quick read for HR: are we typical? Eligible and Enrolled come straight
 * off the last Employee Navigator import; Participation and Contribution
 * are derived from those same figures, so nothing here can disagree with
 * the rest of the page. Eligible is absent on a group imported before this
 * field existed — the square hides itself rather than showing a guess.
 */
export default function HrAnalytics({ eligible, enrolled, contributionPct }: Props) {
  if (eligible == null || eligible <= 0) return null;
  const participationPct = Math.round((enrolled / eligible) * 1000) / 10;

  return (
    <div
      style={{
        flex: "0 0 auto",
        width: 236,
        padding: "12px 14px",
        borderRadius: 6,
        background: C.hairline,
        border: `1px solid ${C.border}`,
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.faint, textTransform: "uppercase", letterSpacing: "0.4px" }}>
        HR Analytics
      </div>
      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 10px" }}>
        <Stat label="Eligible" value={String(eligible)} />
        <Stat label="Enrolled" value={String(enrolled)} />
        <Stat label="Participation" value={`${participationPct}%`} sub={vsBenchmark(participationPct, PARTICIPATION_BENCHMARK)} />
        <Stat label="Contribution" value={`${Math.round(contributionPct * 10) / 10}%`} sub={vsBenchmark(contributionPct, CONTRIBUTION_BENCHMARK)} />
      </div>
    </div>
  );
}
