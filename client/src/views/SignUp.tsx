import { useMemo, useState } from "react";
import {
  marketPlans,
  money0,
  planLimitFor,
  type AccountManager,
  type Group,
  type GroupSignup,
  type KennionData,
  type RenewalElectionFields,
} from "@/lib/model";
import { SUPPLEMENTAL_SECTIONS, EMPLOYER_PAID_LIFE } from "@/lib/supplemental";
import { C, h2, h3, num, panel, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";
import { carrierOf, fundingOf } from "@/views/PlanCard";
import { useNarrow } from "@/lib/narrow";

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

const STEP_LABELS = ["Carrier", "Medical Plans", "Dental", "Vision", "Supplemental", "Employer Life", "Confirm & Sign"];
const letters = "ABCDEFGH";

/** A big selectable card - the carrier, and every lettered option (dental, vision, employer life). One shape, everywhere in the wizard. */
function OptionCard({ letter, title, sub, on, onClick }: { letter?: string; title: string; sub?: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        width: "100%",
        textAlign: "left",
        padding: "13px 16px",
        borderRadius: 8,
        cursor: "pointer",
        border: `1.5px solid ${on ? C.blue : C.border}`,
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
            width: 24,
            height: 24,
            borderRadius: "50%",
            fontSize: 12,
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
        <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.ink }}>{title}</span>
        {sub && <span style={{ display: "block", marginTop: 2, fontSize: 12.5, color: C.muted }}>{sub}</span>}
      </span>
      {on && (
        <span aria-hidden style={{ marginLeft: "auto", flex: "none", color: C.blue }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
      )}
    </button>
  );
}

/** Back / Continue at the foot of every step; Continue can be disabled with a reason. */
function StepNav({ onBack, onContinue, continueLabel = "Continue", disabled, hint }: { onBack?: () => void; onContinue: () => void; continueLabel?: string; disabled?: boolean; hint?: string }) {
  const narrow = useNarrow();
  return (
    <div style={{ marginTop: 18, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          style={{ padding: narrow ? "12px 16px" : "9px 16px", fontSize: 13.5, fontWeight: 500, color: C.body, background: "none", border: `1px solid ${C.border}`, borderRadius: 4, cursor: "pointer" }}
        >
          Back
        </button>
      )}
      <button
        type="button"
        onClick={onContinue}
        disabled={disabled}
        style={{
          padding: narrow ? "13px 20px" : "9px 20px",
          fontSize: 13.5,
          fontWeight: 500,
          color: "#fff",
          background: C.blue,
          border: `1px solid ${C.blue}`,
          borderRadius: 4,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {continueLabel}
      </button>
      {hint && <span style={{ fontSize: 12.5, color: C.muted }}>{hint}</span>}
    </div>
  );
}

/**
 * Sign Up: a guided, six-question wizard that ends in one signed election -
 * carrier, medical plans, dental, vision, a look at what's automatically
 * included, the employer-paid life tier, then a name and an e-mail to sign
 * with. One click at a time, so a first-time HR admin never has to guess
 * what's expected of them. Submitting marks the group Renewed and emails
 * Kennion immediately; nothing here pretends to send.
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

  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [carrier, setCarrier] = useState<string | null>(bases.length === 1 ? bases[0].key : null);
  const [dental, setDental] = useState("");
  const [vision, setVision] = useState("");
  const [employerLife, setEmployerLife] = useState("");
  const [signerName, setSignerName] = useState("");
  const [signerTitle, setSignerTitle] = useState("");
  const [signerEmail, setSignerEmail] = useState("");
  const [signerPhone, setSignerPhone] = useState("");
  const [note, setNote] = useState("");
  const [attest, setAttest] = useState(false);
  const [editing, setEditing] = useState(false);

  const carrierPlans = plans.filter((p) => `${carrierOf(p)} ${fundingOf(p)}` === carrier);
  const short = carrierPlans.filter((p) => selected[p.plan]);
  const tier = carrier && short.length ? planLimitFor(short[0].carrier, g.enrolled) : null;
  const cap = tier ? tier.maxWithUnderwriting ?? tier.maxPlans : null;
  const overLimit = cap != null && short.length > cap;

  const linesFor = (re: RegExp) => (g.lines || []).filter((l) => re.test(l.benefit) && !/medical|health\s*plan/i.test(l.benefit));
  const currentText = (re: RegExp) => {
    const names = [...new Set(linesFor(re).map((l) => l.plan))];
    return names.length ? names.join(", ") : "Nothing on file";
  };

  const dentalSection = SUPPLEMENTAL_SECTIONS.find((s) => s.id === "dental")!;
  const visionSection = SUPPLEMENTAL_SECTIONS.find((s) => s.id === "vision")!;
  const autoIncluded = SUPPLEMENTAL_SECTIONS.filter((s) => ["life", "accident", "critical", "cancer", "hospital", "std"].includes(s.id));

  const goTo = (n: number) => {
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };
  const next = () => goTo(step + 1);
  const back = () => goTo(Math.max(0, step - 1));

  const pickCarrier = (key: string) => {
    setCarrier(key);
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

  // Already renewed, and not mid-edit or freshly submitted: a plain summary,
  // with a way to open the wizard again if something needs to change.
  if (lastSignup?.kind === "renewal" && !sent && !editing) {
    return (
      <div>
        <div className="anchor" style={sectionHead}>
          <h2 style={h2}>Sign Up</h2>
        </div>
        <div style={{ ...panel, padding: "20px 22px", background: C.greenTint, borderColor: C.greenEdge }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 15, fontWeight: 700, color: C.ink }}>
            <span aria-hidden style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: "50%", background: C.green, color: "#fff", flex: "none" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            {g.name} is renewed for 2027
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
              <strong>Dental:</strong> {lastSignup.dental}
            </li>
            <li>
              <strong>Vision:</strong> {lastSignup.vision}
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
          <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, color: C.ink }}>You're All Set - {g.name} Is Renewed For 2027</div>
          <div style={{ margin: "8px auto 0", maxWidth: 460, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
            {managerFirst} has your elections and will follow up to finalize contributions and get 2027 loaded for Open Enrollment. Questions in the meantime? Reach out anytime.
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

      {manager?.calendly && (
        <div
          style={{
            ...panel,
            padding: "16px 18px",
            marginBottom: 18,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            background: C.greenTint,
            borderColor: C.greenEdge,
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>Get Your Kickoff Call On The Calendar</div>
            <div style={{ marginTop: 3, fontSize: 12.5, color: C.body, lineHeight: 1.5 }}>
              Talk through contributions and timing with {managerFirst} - no need to wait until you've signed up below.
            </div>
          </div>
          <a
            className="cta"
            href={manager.calendly}
            target="_blank"
            rel="noreferrer"
            style={{ flex: "none", padding: "9px 16px", fontSize: 13.5, fontWeight: 600, color: "#fff", background: C.green, border: `1px solid ${C.green}`, borderRadius: 4, textDecoration: "none", whiteSpace: "nowrap" }}
          >
            Book Your Kickoff Call &#8599;
          </a>
        </div>
      )}

      {noBasesYet ? (
        <div style={{ ...panel, padding: "18px 20px" }}>
          <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
            No 2027 medical quotes are on file for your group yet, so there's nothing to sign up for just yet. Check{" "}
            <Link href={optionsHref} style={{ color: C.blue }}>
              New 2027 Medical Options
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

          <div style={{ ...panel, padding: narrow ? "18px 16px" : "20px 24px" }}>
            {step === 0 && (
              <>
                <h3 style={h3}>Which Carrier/TPA Are You Choosing For Medical?</h3>
                <p style={{ margin: "4px 0 14px", fontSize: 13, color: C.muted }}>Only carriers with a 2027 quote on file for your group are shown.</p>
                <div style={{ display: "grid", gap: 8 }}>
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
                <p style={{ margin: "4px 0 14px", fontSize: 13, color: C.muted }}>Check every plan you want available to employees during Open Enrollment.</p>
                {overLimit && tier && (
                  <div role="alert" style={{ margin: "0 0 10px", padding: "9px 12px", borderRadius: 4, background: C.redTint, color: C.red, fontSize: 13, lineHeight: 1.5 }}>
                    {carrierOf(carrierPlans[0])} allows up to {cap} plan{cap === 1 ? "" : "s"} for a group this size ({g.enrolled} enrolled){tier.maxWithUnderwriting ? ", even with underwriting approval" : ""}. Uncheck {short.length - (cap as number)} to continue.
                  </div>
                )}
                <div style={{ display: "grid", gap: 6 }}>
                  {carrierPlans.map((p) => (
                    <label
                      key={p.plan}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "10px 14px",
                        borderRadius: 8,
                        border: `1.5px solid ${selected[p.plan] ? C.blue : C.border}`,
                        background: selected[p.plan] ? C.blueTint : C.card,
                        cursor: "pointer",
                      }}
                    >
                      <input type="checkbox" checked={!!selected[p.plan]} onChange={() => onToggleSelected(p.plan)} style={{ accentColor: C.blue, width: 16, height: 16, flex: "none" }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: C.ink }}>{p.plan}</span>
                      <span style={{ flex: "none", fontSize: 13, fontWeight: 600, color: C.ink, ...num }}>{p.monthly == null ? "quote pending" : `${money0(p.monthly)} / mo`}</span>
                    </label>
                  ))}
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!short.length || overLimit} hint={!short.length ? "Select at least one plan" : undefined} />
              </>
            )}

            {step === 2 && (
              <>
                <h3 style={h3}>Dental</h3>
                <p style={{ margin: "4px 0 14px", fontSize: 13, color: C.muted }}>
                  You currently have: <strong>{currentText(/dental/i)}</strong>
                </p>
                <div style={{ display: "grid", gap: 6 }}>
                  {dentalSection.rows.map((r) => (
                    <OptionCard key={r.plan} title={r.plan} sub={`${dentalSection.carrier} · from ${money0(r.ee)}/mo Employee`} on={dental === r.plan} onClick={() => setDental(r.plan)} />
                  ))}
                  <OptionCard title="Waive Dental Coverage" on={dental === "Waive Dental Coverage"} onClick={() => setDental("Waive Dental Coverage")} />
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!dental} />
              </>
            )}

            {step === 3 && (
              <>
                <h3 style={h3}>Vision</h3>
                <p style={{ margin: "4px 0 14px", fontSize: 13, color: C.muted }}>
                  You currently have: <strong>{currentText(/vision/i)}</strong>
                </p>
                <div style={{ display: "grid", gap: 6 }}>
                  {visionSection.rows.map((r) => (
                    <OptionCard key={r.plan} title={r.plan} sub={`${visionSection.carrier} · from ${money0(r.ee)}/mo Employee`} on={vision === r.plan} onClick={() => setVision(r.plan)} />
                  ))}
                  <OptionCard title="Waive Vision Coverage" on={vision === "Waive Vision Coverage"} onClick={() => setVision("Waive Vision Coverage")} />
                </div>
                <StepNav onBack={back} onContinue={next} disabled={!vision} />
              </>
            )}

            {step === 4 && (
              <>
                <h3 style={h3}>Included With Your Package</h3>
                <p style={{ margin: "4px 0 14px", fontSize: 13, color: C.muted }}>
                  These are automatically part of what Kennion offers - <strong>no direct cost to you</strong>. Employees may elect and pay for any of them voluntarily during Open Enrollment.
                </p>
                <div style={{ display: "grid", gap: 6 }}>
                  {autoIncluded.map((s) => (
                    <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 8, border: `1px solid ${C.border}` }}>
                      <span aria-hidden style={{ flex: "none", color: C.green }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <span style={{ fontSize: 13.5, color: C.ink }}>
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
                <p style={{ margin: "4px 0 14px", fontSize: 13, color: C.muted }}>This is an optional employer-paid benefit. Prices are monthly, per employee.</p>
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: narrow ? "1fr" : "repeat(2, 1fr)" }}>
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
                <div style={{ margin: "8px 0 16px", padding: "12px 14px", borderRadius: 8, background: C.zebra, fontSize: 13, color: C.body, lineHeight: 2 }}>
                  <div>
                    <strong style={{ color: C.ink }}>Medical:</strong> {carrierOf(carrierPlans[0]) || "-"} - {short.map((s) => s.plan).join(", ")}
                  </div>
                  <div>
                    <strong style={{ color: C.ink }}>Dental:</strong> {dental}
                  </div>
                  <div>
                    <strong style={{ color: C.ink }}>Vision:</strong> {vision}
                  </div>
                  <div>
                    <strong style={{ color: C.ink }}>Employer Paid Life:</strong> {employerLife}
                  </div>
                </div>

                <div style={{ display: "grid", gap: 10, gridTemplateColumns: narrow ? "1fr" : "1fr 1fr" }}>
                  <label style={{ fontSize: 12.5, color: C.muted }}>
                    Your Name *
                    <input value={signerName} onChange={(e) => setSignerName(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 12.5, color: C.muted }}>
                    Your Title
                    <input value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 12.5, color: C.muted }}>
                    Email *
                    <input type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ fontSize: 12.5, color: C.muted }}>
                    Phone
                    <input type="tel" value={signerPhone} onChange={(e) => setSignerPhone(e.target.value)} style={inputStyle} />
                  </label>
                </div>

                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  aria-label="Questions for your account manager"
                  placeholder="Anything else for your account manager - contribution changes, timing, questions - optional"
                  style={{ marginTop: 12, width: "100%", minHeight: 70, padding: "10px 12px", fontSize: 13.5, lineHeight: 1.55, color: C.ink, border: `1px solid ${C.inputEdge}`, borderRadius: 4, outline: "none", resize: "vertical" }}
                />

                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 14, fontSize: 12.5, color: C.body, cursor: "pointer" }}>
                  <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} style={{ marginTop: 2, accentColor: C.blue, width: 16, height: 16, flex: "none" }} />
                  I confirm I am authorized to make these elections on behalf of {g.name}, and that typing my name above is my electronic signature confirming this 2027 benefits election.
                </label>

                <StepNav onBack={back} onContinue={submit} continueLabel={submitting ? "Submitting…" : "Confirm & Renew For 2027"} disabled={submitting || !signerName.trim() || !emailOk || !attest} />
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
  marginTop: 4,
  padding: "8px 10px",
  fontSize: 13.5,
  color: C.ink,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: 4,
  outline: "none",
  boxSizing: "border-box" as const,
};
