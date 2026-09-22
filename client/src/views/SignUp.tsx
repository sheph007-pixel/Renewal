import { useMemo, useState } from "react";
import {
  marketPlans,
  planLimitFor,
  type AccountManager,
  type Group,
  type GroupSignup,
  type KennionData,
  type RenewalElectionFields,
  type SupplementalLine,
} from "@/lib/model";
import { SUPPLEMENTAL_SECTIONS, EMPLOYER_PAID_LIFE, type SupplementalRow } from "@/lib/supplemental";
import { C, h2, h3, panel, sectionHead, textInput } from "@/lib/ui";
import Link from "@/lib/Link";
import { carrierOf, fundingOf } from "@/views/PlanCard";
import { useNarrow } from "@/lib/narrow";
import { money0, networkTypeOf } from "@/lib/model";
import CarrierMark from "@/views/CarrierMark";

interface Props {
  data: KennionData;
  g: Group;
  selected: Record<string, boolean>;
  sent: boolean;
  submitting: boolean;
  submitError: string;
  /** The most recent submission on file for this group, if any. */
  lastSignup: GroupSignup | null;
  optionsHref: string;
  manager: AccountManager | null | undefined;
  onToggleSelected: (plan: string) => void;
  onSubmit: (fields: RenewalElectionFields) => void;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

const STEP_LABELS = ["Carrier/TPA", "Medical Plans", "Dental", "Vision", "Supplemental", "Employer Life", "Confirm & Sign"];
const letters = "ABCDEFGH";
const DENTAL_VISION_MAX = 3;

/** The first dollar figure in a plan name - its deductible, almost always. Plans with no figure (a "Comfort" tier, say) sort last. */
const planAmount = (s: string): number => {
  const m = s.match(/\$([\d,]+)/);
  return m ? Number(m[1].replace(/,/g, "")) : Infinity;
};

type PlanSortKey = "option" | "network" | "plan";

/**
 * Which rows in a section (dental or vision) to flag with the "Current Plan"
 * star: an exact name match against what the group already has, section-wide,
 * if there is one. Several dental rows are the same plan at two tiers - "X"
 * and "X (W Ortho)" - a real, differently priced difference, not a spelling
 * variant, so an exact match always wins over a loose one: normalizing used
 * to strip the "(W Ortho)" qualifier entirely, which made those two rows
 * indistinguishable and starred both whenever the group's line was the plain
 * "X". Only when nothing in the section matches exactly do we fall back to a
 * loose, either-way substring match, since the export rarely spells a plan
 * the way the catalogue does.
 */
function currentPlanNames(rows: SupplementalRow[], lines: SupplementalLine[]): Set<string> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lineKeys = lines.map((l) => norm(l.plan)).filter(Boolean);
  if (!lineKeys.length) return new Set();
  const exact = rows.filter((r) => lineKeys.includes(norm(r.plan)));
  if (exact.length) return new Set(exact.map((r) => r.plan));
  const loose = rows.filter((r) => {
    const key = norm(r.plan);
    return !!key && lineKeys.some((lk) => lk.includes(key) || key.includes(lk));
  });
  return new Set(loose.map((r) => r.plan));
}

/** The company name, front and center - every step of the way, so it never reads like a generic form. */
function CompanyBanner({ g }: { g: Group }) {
  return (
    <div style={{ ...panel, padding: "16px 20px", marginBottom: 18, display: "flex", alignItems: "center", gap: 14 }}>
      <span aria-hidden style={{ flex: "none", display: "grid", placeItems: "center", width: 42, height: 42, borderRadius: 10, background: C.navy, color: "#fff", fontSize: 16, fontWeight: 700 }}>
        {g.name
          .replace(/[^A-Za-z0-9 ]/g, " ")
          .split(/\s+/)
          .filter((w) => w && !/^(inc|llc|co|corp|corporation|company|the|of|and)$/i.test(w))
          .slice(0, 2)
          .map((w) => w[0])
          .join("")
          .toUpperCase()}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.ink, lineHeight: 1.3 }}>{g.name}</div>
        <div style={{ fontSize: 12.5, color: C.muted, marginTop: 1 }}>Benefits Election</div>
      </div>
    </div>
  );
}

/** A big selectable card - the carrier, and every lettered option (employer life). One shape, everywhere it's a single choice. */
function OptionCard({ letter, title, sub, on, onClick }: { letter?: string; title: string; sub?: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        width: "100%",
        textAlign: "left",
        padding: "16px 18px",
        borderRadius: 10,
        cursor: "pointer",
        border: `2px solid ${on ? C.blue : C.border}`,
        background: on ? C.blueTint : C.card,
      }}
    >
      {letter && (
        <span
          aria-hidden
          style={{
            flex: "none",
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: "50%",
            fontSize: 13.5,
            fontWeight: 700,
            color: on ? "#fff" : C.faint,
            background: on ? C.blue : C.zebra,
            border: `1px solid ${on ? C.blue : C.border}`,
          }}
        >
          {letter}
        </span>
      )}
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15.5, fontWeight: 600, color: C.ink }}>{title}</span>
        {sub && <span style={{ display: "block", marginTop: 2, fontSize: 13, color: C.muted }}>{sub}</span>}
      </span>
      {on && (
        <span aria-hidden style={{ marginLeft: "auto", flex: "none", color: C.blue }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )}
    </button>
  );
}

/** A checkbox row - medical plans, and dental/vision's up-to-3 picks. `current` stars the plan the group already has. */
function CheckOption({ title, current, checked, disabled, onClick }: { title: string; current?: boolean; checked: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "15px 18px",
        borderRadius: 10,
        border: `2px solid ${checked ? C.blue : current ? C.amber : C.border}`,
        background: checked ? C.blueTint : current ? C.amberTint : C.card,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onClick} style={{ accentColor: C.blue, width: 19, height: 19, flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>{title}</span>
      {current && (
        <span
          aria-hidden
          style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 700, color: C.amber, background: "#fff", border: `1px solid ${C.amberEdge}`, borderRadius: 12, padding: "3px 10px" }}
        >
          ★ Current Plan
        </span>
      )}
    </label>
  );
}

/** Back / Continue at the foot of every step; Continue can be disabled with a reason. */
function StepNav({ onBack, onContinue, continueLabel = "Continue", disabled, hint }: { onBack?: () => void; onContinue: () => void; continueLabel?: string; disabled?: boolean; hint?: string }) {
  return (
    <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{ padding: "14px 20px", fontSize: 14.5, fontWeight: 500, color: C.body, background: "none", border: `1px solid ${C.border}`, borderRadius: 6, cursor: "pointer" }}
        >
          Back
        </button>
      )}
      <button
        type="button"
        onClick={onContinue}
        disabled={disabled}
        style={{
          padding: "14px 24px",
          fontSize: 14.5,
          fontWeight: 600,
          color: "#fff",
          background: C.blue,
          border: `1px solid ${C.blue}`,
          borderRadius: 6,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {continueLabel}
      </button>
      {hint && <span style={{ fontSize: 13, color: C.muted }}>{hint}</span>}
    </div>
  );
}

/** Toggle a value in an up-to-`max` list; picking "Waive…" clears the rest and stands alone. */
function toggleCapped(list: string[], value: string, max: number): string[] {
  if (/^Waive/.test(value)) return list.includes(value) ? [] : [value];
  const rest = list.filter((v) => !/^Waive/.test(v));
  if (rest.includes(value)) return rest.filter((v) => v !== value);
  return rest.length < max ? [...rest, value] : rest;
}

/**
 * Sign Up: a guided, seven-question wizard that ends in one signed election -
 * carrier, medical plans, dental, vision, a look at what's automatically
 * included, the employer-paid life tier, then a name and an e-mail to sign
 * with. One click at a time, so a first-time HR admin never has to guess
 * what's expected of them. Submitting marks the group Renewed and emails
 * Kennion immediately; nothing here pretends to send. No rate or premium
 * figure appears anywhere on this form - that is a conversation with the
 * account manager, not a checkbox here.
 */
export default function SignUp({ data, g, selected, sent, submitting, submitError, lastSignup, optionsHref, manager, onToggleSelected, onSubmit }: Props) {
  const narrow = useNarrow();
  const managerFirst = manager?.name ? manager.name.split(" ")[0] : "your account manager";

  // Every priced medical plan, grouped by the one carrier + funding type it
  // is quoted under - a group can only elect a carrier it actually has a
  // 2027 quote from, so nothing un-quoted ever shows up as an option.
  const plans = marketPlans(data, g);
  const bases = useMemo(() => {
    const map = new Map<string, { carrier: string; funding: string; count: number }>();
    for (const p of plans) {
      const carrier = carrierOf(p);
      const funding = fundingOf(p);
      const key = `${carrier} ${funding}`;
      const cur = map.get(key) || { carrier, funding, count: 0 };
      cur.count++;
      map.set(key, cur);
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }, [plans]);

  // Renewing prior coverage and enrolling for the first time are the same
  // form and the same logic - only the verb on screen changes.
  const actionVerb = g.groupStatus === "new" ? "Enroll" : "Renew";
  const actionPast = g.groupStatus === "new" ? "enrolled" : "renewed";

  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [carrier, setCarrier] = useState<string | null>(bases.length === 1 ? bases[0].key : null);
  const [planSearch, setPlanSearch] = useState("");
  const [planSort, setPlanSort] = useState<{ key: PlanSortKey; dir: 1 | -1 }>({ key: "plan", dir: 1 });
  const [dental, setDental] = useState<string[]>([]);
  const [vision, setVision] = useState<string[]>([]);
  const [employerLife, setEmployerLife] = useState("");
  const [signerName, setSignerName] = useState("");
  const [signerTitle, setSignerTitle] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [signerPhone, setSignerPhone] = useState("");
  const [note, setNote] = useState("");
  const [attest, setAttest] = useState(false);
  const [editing, setEditing] = useState(false);

  const carrierPlans = plans.filter((p) => `${carrierOf(p)} ${fundingOf(p)}` === carrier);
  // Defaults to lowest deductible first, so a long carrier list reads
  // richest-to-leanest rather than in raw catalogue order; every column
  // header can also be clicked to sort by it, same as the real grid.
  const carrierPlansSorted = [...carrierPlans].sort((a, b) => {
    const cmp =
      planSort.key === "option"
        ? (a.optionId || "").localeCompare(b.optionId || "", undefined, { numeric: true })
        : planSort.key === "network"
          ? (networkTypeOf(a) || "").localeCompare(networkTypeOf(b) || "")
          : planAmount(a.plan) - planAmount(b.plan) || a.plan.localeCompare(b.plan);
    return cmp * planSort.dir;
  });
  const sortOnPlan = (key: PlanSortKey) => setPlanSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const planQuery = planSearch.trim().toLowerCase();
  const visiblePlans = planQuery ? carrierPlansSorted.filter((p) => p.plan.toLowerCase().includes(planQuery)) : carrierPlansSorted;
  const short = carrierPlans.filter((p) => selected[p.plan]);
  const tier = carrier && short.length ? planLimitFor(short[0].carrier, g.enrolled) : null;
  const cap = tier ? tier.maxWithUnderwriting ?? tier.maxPlans : null;
  const overLimit = cap != null && short.length > cap;

  const linesFor = (re: RegExp) => (g.lines || []).filter((l) => re.test(l.benefit) && !/medical|health\s*plan/i.test(l.benefit));
  const currentDentalLines = linesFor(/dental/i);
  const currentVisionLines = linesFor(/vision/i);

  const dentalSection = SUPPLEMENTAL_SECTIONS.find((s) => s.id === "dental")!;
  const visionSection = SUPPLEMENTAL_SECTIONS.find((s) => s.id === "vision")!;
  const currentDentalPlans = currentPlanNames(dentalSection.rows, currentDentalLines);
  const currentVisionPlans = currentPlanNames(visionSection.rows, currentVisionLines);
  const autoIncluded = SUPPLEMENTAL_SECTIONS.filter((s) => ["life", "accident", "critical", "cancer", "hospital", "std"].includes(s.id));

  const goTo = (n: number) => {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };
  const next = () => goTo(step + 1);
  const back = () => goTo(Math.max(0, step - 1));

  const pickCarrier = (key: string) => {
    setCarrier(key);
    setPlanSearch("");
    setPlanSort({ key: "plan", dir: 1 });
    // A plan checked earlier from the Options grid, under a different
    // carrier, cannot ride along - one carrier, one election.
    const keep = new Set(plans.filter((p) => `${carrierOf(p)} ${fundingOf(p)}` === key).map((p) => p.plan));
    Object.keys(selected).forEach((p) => selected[p] && !keep.has(p) && onToggleSelected(p));
  };

  const submit = () => {
    onSubmit({
      plans: short.map((s) => s.plan),
      dental,
      vision,
      employerLife,
      signerName: signerName.trim(),
      signerTitle: signerTitle.trim(),
      signerEmail: signerEmail.trim(),
      signerPhone: signerPhone.trim(),
      note: note.trim(),
      attest,
    });
  };

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail.trim());
  const phoneOk = signerPhone.replace(/\D/g, "").length >= 10;

  // Already renewed, and not mid-edit or freshly submitted: a plain summary,
  // with a way to open the wizard again if something needs to change.
  if (lastSignup?.kind === "renewal" && !sent && !editing) {
    return (
      <div>
        <div className="anchor" style={sectionHead}>
          <h2 style={h2}>Sign Up</h2>
        </div>
        <CompanyBanner g={g} />
        <div style={{ ...panel, padding: "20px 22px", background: C.greenTint, borderColor: C.greenEdge }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 15, fontWeight: 700, color: C.ink }}>
            <span aria-hidden style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: "50%", background: C.green, color: "#fff", flex: "none" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            {g.name} is {actionPast}
          </div>
          <div style={{ marginTop: 10, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
            Signed {fmtDate(lastSignup.submittedAt)} by {lastSignup.signerName}
            {lastSignup.signerTitle ? `, ${lastSignup.signerTitle}` : ""}.
          </div>
          <ul style={{ margin: "10px 0 0", padding: "0 0 0 18px", fontSize: 13, color: C.body, lineHeight: 1.8 }}>
            <li>
              <strong>Medical:</strong> {lastSignup.carrier || "-"} - {lastSignup.plans.join(", ")}
            </li>
            <li>
              <strong>Dental:</strong> {lastSignup.dental.join(", ")}
            </li>
            <li>
              <strong>Vision:</strong> {lastSignup.vision.join(", ")}
            </li>
            <li>
              <strong>Employer Paid Life:</strong> {lastSignup.employerLife}
            </li>
          </ul>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="noprint"
            style={{ marginTop: 14, padding: "9px 16px", fontSize: 13, fontWeight: 500, color: C.ink, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 4, cursor: "pointer" }}
          >
            Something Changed? Update Your Elections
          </button>
        </div>
      </div>
    );
  }

  // Just submitted, this session: a clean confirmation rather than dropping
  // back into the form.
  if (sent) {
    return (
      <div>
        <div className="anchor" style={sectionHead}>
          <h2 style={h2}>Sign Up</h2>
        </div>
        <div style={{ ...panel, padding: "26px 24px", textAlign: "center", background: C.greenTint, borderColor: C.greenEdge }}>
          <div style={{ fontSize: 30 }}>🎉</div>
          <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, color: C.ink }}>You're All Set - {g.name} Has {actionVerb === "Enroll" ? "Enrolled" : "Renewed"}</div>
          <div style={{ margin: "8px auto 0", maxWidth: 460, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
            {managerFirst} has your elections and will follow up to finalize contributions and get everything loaded for Open Enrollment. Questions in the meantime? Reach out anytime.
          </div>
        </div>
      </div>
    );
  }

  const noBasesYet = bases.length === 0;

  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>Sign Up</h2>
      </div>

      <CompanyBanner g={g} />

      {noBasesYet ? (
        <div style={{ ...panel, padding: "18px 20px" }}>
          <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
            No medical quotes are on file for your group yet, so there's nothing to sign up for just yet. Check{" "}
            <Link href={optionsHref} style={{ color: C.blue }}>
              New Medical Options
            </Link>{" "}
            soon, or reach out to {managerFirst}.
          </p>
        </div>
      ) : (
        <>
          {/* Progress: a dot per step, the ones already visited are clickable. */}
          <div className="noprint" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
            {STEP_LABELS.map((label, i) => (
              <button
                key={label}
                type="button"
                disabled={i > maxStep}
                onClick={() => goTo(i)}
                style={{
                  padding: "5px 10px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  borderRadius: 12,
                  border: `1px solid ${i === step ? C.blue : C.border}`,
                  background: i === step ? C.blue : i < step ? C.blueTint : C.card,
                  color: i === step ? "#fff" : i <= maxStep ? C.ink : C.faint,
                  cursor: i > maxStep ? "default" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {i + 1}. {label}
              </button>
            ))}
          </div>

          <div style={{ ...panel, padding: narrow ? "20px 18px" : "26px 30px" }}>
            {step === 0 && (
              <>
                <h3 style={h3}>Which Carrier/TPA Are You Choosing For Medical?</h3>
                <p style={{ margin: "4px 0 16px", fontSize: 13.5, color: C.muted }}>Only carriers with a quote on file for your group are shown.</p>
                <div style={{ display: "grid", gap: 10 }}>
                  {bases.map((b, i) => (
                    <OptionCard key={b.key} letter={letters[i]} title={`${b.carrier} - ${b.funding}`} sub={`${b.count} plan${b.count === 1 ? "" : "s"} available`} on={carrier === b.key} onClick={() => pickCarrier(b.key)} />
                  ))}
                </div>
                <StepNav onContinue={next} disabled={!carrier} />
              </>
            )}

            {step === 1 && (
              <>
                <h3 style={h3}>Which {carrierOf(carrierPlans[0]) || "Medical"} Plans Do You Want To Offer?</h3>
                <p style={{ margin: "4px 0 16px", fontSize: 13.5, color: C.muted }}>Click a plan to add or remove it - the same grid you've already seen, sorted lowest deductible first.</p>
                {overLimit && tier && (
                  <div role="alert" style={{ margin: "0 0 12px", padding: "10px 14px", borderRadius: 6, background: C.redTint, color: C.red, fontSize: 13.5, lineHeight: 1.5 }}>
                    {carrierOf(carrierPlans[0])} allows up to {cap} plan{cap === 1 ? "" : "s"} for a group this size ({g.enrolled} enrolled){tier.maxWithUnderwriting ? ", even with underwriting approval" : ""}. Uncheck {short.length - (cap as number)} to continue.
                  </div>
                )}
                {carrierPlans.length > 6 && (
                  <input
                    type="search"
                    value={planSearch}
                    onChange={(e) => setPlanSearch(e.target.value)}
                    placeholder={`Search ${carrierPlans.length} plans…`}
                    aria-label="Search plans"
                    style={{ ...textInput, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
                  />
                )}
                <div style={{ overflow: "auto", border: `1px solid ${C.hairline}`, borderRadius: 8 }}>
                  <table style={{ width: "100%", minWidth: 480, borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr>
                        {(
                          [
                            ["option", "Option"],
                            [null, "Carrier/TPA"],
                            ["network", "Network Type"],
                            ["plan", "Plan"],
                          ] as [PlanSortKey | null, string][]
                        ).map(([k, h]) => (
                          <th
                            key={h}
                            onClick={k ? () => sortOnPlan(k) : undefined}
                            title={k ? "Sort by this column" : undefined}
                            aria-sort={k && planSort.key === k ? (planSort.dir > 0 ? "ascending" : "descending") : undefined}
                            style={{
                              padding: "12px 10px 11px",
                              fontSize: 13,
                              color: C.onColor,
                              background: C.headerBg,
                              fontWeight: 700,
                              textAlign: "left",
                              whiteSpace: "nowrap",
                              cursor: k ? "pointer" : undefined,
                              userSelect: "none",
                            }}
                          >
                            {h}
                            {k && planSort.key === k ? (planSort.dir > 0 ? " ▲" : " ▼") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {!visiblePlans.length && (
                        <tr>
                          <td colSpan={4} style={{ padding: "14px 10px", fontSize: 13.5, color: C.muted }}>
                            No plans match "{planSearch}".
                          </td>
                        </tr>
                      )}
                      {visiblePlans.map((p, i) => {
                        const on = !!selected[p.plan];
                        const cell = { padding: "10px 10px", borderBottom: `1px solid ${C.hairline}`, color: C.ink };
                        return (
                          <tr
                            key={p.plan}
                            onClick={() => onToggleSelected(p.plan)}
                            style={{ background: on ? C.blueTint : i % 2 ? C.zebra : C.card, cursor: "pointer" }}
                          >
                            <td style={{ ...cell, whiteSpace: "nowrap", fontWeight: 700, color: p.optionId ? C.ink : C.faint }}>{p.optionId ?? "-"}</td>
                            <td style={{ ...cell, whiteSpace: "nowrap" }}>
                              <CarrierMark name={carrierOf(p)} size={20} fontSize={12.5} color={C.body} />
                            </td>
                            <td style={{ ...cell, whiteSpace: "nowrap" }}>{networkTypeOf(p) || "-"}</td>
                            <td style={{ ...cell, fontWeight: on ? 700 : 500 }}>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                {on && (
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: "none" }}>
                                    <path d="M20 6 9 17l-5-5" />
                                  </svg>
                                )}
                                {p.plan}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!short.length || overLimit} hint={!short.length ? "Select at least one plan" : undefined} />
              </>
            )}

            {step === 2 && (
              <>
                <h3 style={h3}>Dental</h3>
                <p style={{ margin: "4px 0 16px", fontSize: 13.5, color: C.muted }}>
                  Choose up to {DENTAL_VISION_MAX} plans to offer. <span style={{ color: C.amber, fontWeight: 600 }}>★ Current Plan</span> is what you have today.
                </p>
                <div style={{ display: "grid", gap: 8 }}>
                  {dentalSection.rows.map((r: SupplementalRow) => (
                    <CheckOption
                      key={r.plan}
                      title={r.plan}
                      current={currentDentalPlans.has(r.plan)}
                      checked={dental.includes(r.plan)}
                      disabled={!dental.includes(r.plan) && (dental.length >= DENTAL_VISION_MAX || dental.includes("Waive Dental Coverage"))}
                      onClick={() => setDental((d) => toggleCapped(d, r.plan, DENTAL_VISION_MAX))}
                    />
                  ))}
                  <CheckOption title="Waive Dental Coverage" checked={dental.includes("Waive Dental Coverage")} onClick={() => setDental((d) => toggleCapped(d, "Waive Dental Coverage", DENTAL_VISION_MAX))} />
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!dental.length} hint={dental.length ? `${dental.length} of ${DENTAL_VISION_MAX} selected` : undefined} />
              </>
            )}

            {step === 3 && (
              <>
                <h3 style={h3}>Vision</h3>
                <p style={{ margin: "4px 0 16px", fontSize: 13.5, color: C.muted }}>
                  Choose up to {DENTAL_VISION_MAX} plans to offer. <span style={{ color: C.amber, fontWeight: 600 }}>★ Current Plan</span> is what you have today.
                </p>
                <div style={{ display: "grid", gap: 8 }}>
                  {visionSection.rows.map((r: SupplementalRow) => (
                    <CheckOption
                      key={r.plan}
                      title={r.plan}
                      current={currentVisionPlans.has(r.plan)}
                      checked={vision.includes(r.plan)}
                      disabled={!vision.includes(r.plan) && (vision.length >= DENTAL_VISION_MAX || vision.includes("Waive Vision Coverage"))}
                      onClick={() => setVision((v) => toggleCapped(v, r.plan, DENTAL_VISION_MAX))}
                    />
                  ))}
                  <CheckOption title="Waive Vision Coverage" checked={vision.includes("Waive Vision Coverage")} onClick={() => setVision((v) => toggleCapped(v, "Waive Vision Coverage", DENTAL_VISION_MAX))} />
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!vision.length} hint={vision.length ? `${vision.length} of ${DENTAL_VISION_MAX} selected` : undefined} />
              </>
            )}

            {step === 4 && (
              <>
                <h3 style={h3}>Included With Your Package</h3>
                <p style={{ margin: "4px 0 16px", fontSize: 13.5, color: C.muted }}>
                  These are automatically part of what Kennion offers - <strong>no direct cost to you</strong>. Employees may elect and pay for any of them voluntarily during Open Enrollment.
                </p>
                <div style={{ display: "grid", gap: 8 }}>
                  {autoIncluded.map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderRadius: 10, border: `1px solid ${C.border}` }}>
                      <span aria-hidden style={{ flex: "none", color: C.green }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <span style={{ fontSize: 14.5, color: C.ink }}>
                        {s.product} <span style={{ color: C.faint }}>· {s.carrier}</span>
                      </span>
                    </div>
                  ))}
                </div>
                <StepNav onBack={back} onContinue={next} continueLabel="Continue" />
              </>
            )}

            {step === 5 && (
              <>
                <h3 style={h3}>100% Employer Paid Life Insurance - Guardian</h3>
                <p style={{ margin: "4px 0 16px", fontSize: 13.5, color: C.muted }}>This is an optional employer-paid benefit.</p>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: narrow ? "1fr" : "repeat(2, 1fr)" }}>
                  {EMPLOYER_PAID_LIFE.map((o, i) => {
                    const label = o.pepm != null ? `${o.label} (${money0(o.pepm)} Per Employee)` : o.label;
                    return <OptionCard key={o.key} letter={letters[i]} title={label} on={employerLife === label} onClick={() => setEmployerLife(label)} />;
                  })}
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!employerLife} />
              </>
            )}

            {step === 6 && (
              <>
                <h3 style={h3}>Confirm &amp; Sign</h3>
                <div style={{ margin: "8px 0 18px", padding: "16px 18px", borderRadius: 10, background: C.zebra, fontSize: 13.5, color: C.body, lineHeight: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.4px", color: C.faint, textTransform: "uppercase", marginBottom: 4 }}>Election Summary · {g.name}</div>
                  <div>
                    <strong style={{ color: C.ink }}>Medical:</strong> {carrierOf(carrierPlans[0]) || "-"} - {short.map((s) => s.plan).join(", ")}
                  </div>
                  <div>
                    <strong style={{ color: C.ink }}>Dental:</strong> {dental.join(", ")}
                  </div>
                  <div>
                    <strong style={{ color: C.ink }}>Vision:</strong> {vision.join(", ")}
                  </div>
                  <div>
                    <strong style={{ color: C.ink }}>Employer Paid Life:</strong> {employerLife}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 12, gridTemplateColumns: narrow ? "1fr" : "1fr 1fr" }}>
                  <label style={{ fontSize: 13, color: C.muted }}>
                    Your Name *
                    <input required value={signerName} onChange={(e) => setSignerName(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 13, color: C.muted }}>
                    Your Title *
                    <input required value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 13, color: C.muted }}>
                    Email *
                    <input required type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 13, color: C.muted }}>
                    Phone *
                    <input required type="tel" value={signerPhone} onChange={(e) => setSignerPhone(e.target.value)} style={inputStyle} />
                  </label>
                </div>

                <label style={{ display: "block", marginTop: 14, fontSize: 13, color: C.muted }}>
                  Questions For Your Account Manager *
                  <textarea
                    required
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Contribution changes, timing, anything else before we finalize your elections"
                    style={{ display: "block", marginTop: 5, width: "100%", minHeight: 74, padding: "11px 13px", fontSize: 14, lineHeight: 1.55, color: C.ink, border: `1px solid ${C.inputEdge}`, borderRadius: 6, outline: "none", resize: "vertical", boxSizing: "border-box" }}
                  />
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 16, fontSize: 13, color: C.body, cursor: "pointer" }}>
                  <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} style={{ marginTop: 2, accentColor: C.blue, width: 17, height: 17, flex: "none" }} />
                  I confirm I am authorized to make these elections on behalf of {g.name}, and that typing my name above is my electronic signature confirming this benefits election.
                </label>

                <StepNav
                  onBack={back}
                  onContinue={submit}
                  continueLabel={submitting ? "Submitting…" : `Confirm & ${actionVerb}`}
                  disabled={submitting || !signerName.trim() || !signerTitle.trim() || !emailOk || !phoneOk || !note.trim() || !attest}
                />
                {submitError && (
                  <div role="alert" style={{ marginTop: 10, fontSize: 13, color: C.red }}>
                    {submitError}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const inputStyle = {
  display: "block",
  width: "100%",
  marginTop: 5,
  padding: "10px 12px",
  fontSize: 14,
  color: C.ink,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: 6,
  outline: "none",
  boxSizing: "border-box" as const,
};
