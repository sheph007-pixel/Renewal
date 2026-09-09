import { useState } from "react";
import {
  marketPlans,
  money0,
  type AccountManager,
  type Group,
  type GroupSignup,
  type KennionData,
} from "@/lib/model";
import { C, h2, num, panel, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";

interface Props {
  data: KennionData;
  g: Group;
  selected: Record<string, boolean>;
  note: string;
  sent: boolean;
  submitting: boolean;
  submitError: string;
  /** The most recent submission on file for this group, if any. */
  lastSignup: GroupSignup | null;
  optionsHref: string;
  manager: AccountManager | null | undefined;
  onToggleSelected: (plan: string) => void;
  onNote: (v: string) => void;
  onSubmit: () => void;
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/**
 * Where a shortlist built on New 2027 Medical Plans is reviewed, noted, and
 * actually sent. This used to be a panel at the bottom of the options page
 * that only pretended to send — the button just flipped a flag in the
 * browser. It now posts to Kennion and is kept: your account manager sees
 * exactly what came in and when.
 */
export default function SignUp({
  data,
  g,
  selected,
  note,
  sent,
  submitting,
  submitError,
  lastSignup,
  optionsHref,
  manager,
  onToggleSelected,
  onNote,
  onSubmit,
}: Props) {
  const [confirmClear, setConfirmClear] = useState(false);
  const plans = marketPlans(data, g);
  const short = plans.filter((p) => selected[p.plan]);
  const managerFirst = manager?.name ? manager.name.split(" ")[0] : "your account manager";

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
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>Get your kickoff call on the calendar</div>
            <div style={{ marginTop: 3, fontSize: 12.5, color: C.body, lineHeight: 1.5 }}>
              Talk through your shortlist, contribution strategy, and timing with {managerFirst} — no need to wait
              until you've picked plans below.
            </div>
          </div>
          <a
            href={manager.calendly}
            target="_blank"
            rel="noreferrer"
            style={{
              flex: "none",
              padding: "9px 16px",
              fontSize: 13.5,
              fontWeight: 600,
              color: "#fff",
              background: C.green,
              border: `1px solid ${C.green}`,
              borderRadius: 4,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            Book your kickoff call &#8599;
          </a>
        </div>
      )}

      {lastSignup && (
        <div style={{ ...panel, padding: "14px 18px", marginBottom: 18, background: C.blueTint, borderColor: C.blueEdge }}>
          <div style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>
            Last submitted {fmtDate(lastSignup.submittedAt)}
          </div>
          <div style={{ marginTop: 3, fontSize: 12.5, color: C.body }}>
            {lastSignup.plans.length} plan{lastSignup.plans.length === 1 ? "" : "s"}: {lastSignup.plans.join(", ")}
            {lastSignup.note ? ` · “${lastSignup.note}”` : ""}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: C.faint }}>
            Changed your mind, or want to add another plan? Build a new shortlist below and send it — it does
            not replace the one on file, it just gives {managerFirst} the latest.
          </div>
        </div>
      )}

      <div className="panel" style={{ ...panel, padding: "18px 20px" }}>
        {short.length === 0 ? (
          <>
            <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
              Nothing shortlisted yet. Check any plan on{" "}
              <Link href={optionsHref} style={{ color: C.blue }}>
                New 2027 Medical Plans
              </Link>{" "}
              to add it here.
            </p>
          </>
        ) : (
          <>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: C.muted }}>
              {short.length} plan{short.length > 1 ? "s" : ""} shortlisted. Add a note if you like, then send it
              — {managerFirst} will come back with firm rates and a contribution model.
            </p>
            {short.map((s) => (
              <div
                key={s.plan}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 14,
                  padding: "10px 0",
                  borderTop: `1px solid ${C.hairline}`,
                  fontSize: 13.5,
                }}
              >
                <span style={{ color: C.ink }}>
                  <strong>{s.plan}</strong>{" "}
                  <span style={{ color: C.faint }}>{s.carrier.replace(" (UnitedHealthcare)", " by UHC")}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <span style={{ fontWeight: 600, color: C.ink, ...num }}>
                    {s.monthly == null ? "quote pending" : `${money0(s.monthly)} / mo`}
                  </span>
                  <button
                    onClick={() => onToggleSelected(s.plan)}
                    className="noprint"
                    style={{ background: "none", border: "none", color: C.blue, fontSize: 13, cursor: "pointer", padding: 0 }}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ))}

            <textarea
              value={note}
              onChange={(e) => onNote(e.target.value)}
              aria-label="Questions for your account manager"
              placeholder="Questions for your account manager — anything you want quoted differently, contribution changes, timing…"
              style={{
                marginTop: 14,
                width: "100%",
                minHeight: 84,
                padding: "10px 12px",
                fontSize: 13.5,
                lineHeight: 1.55,
                color: C.ink,
                border: `1px solid ${C.inputEdge}`,
                borderRadius: 4,
                outline: "none",
                resize: "vertical",
              }}
            />

            <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <button
                onClick={onSubmit}
                disabled={submitting}
                className="noprint"
                style={{
                  padding: "9px 18px",
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: "#fff",
                  background: C.blue,
                  border: `1px solid ${C.blue}`,
                  borderRadius: 4,
                  cursor: submitting ? "default" : "pointer",
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? "Sending…" : "Send to " + managerFirst}
              </button>
              <span style={{ fontSize: 12.5, color: C.muted }}>
                {sent
                  ? `Sent${manager?.email ? ` · ${manager.email}` : ""}. We'll respond within one business day.`
                  : `Goes to ${manager?.name || "Kennion"}${manager?.email ? ` · ${manager.email}` : ""}.`}
              </span>
            </div>
            {submitError && (
              <div role="alert" style={{ marginTop: 10, fontSize: 13, color: C.red }}>
                {submitError}
              </div>
            )}
          </>
        )}
      </div>

      {short.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {confirmClear ? (
            <span style={{ fontSize: 12.5, color: C.faint }}>
              Clear the whole shortlist?{" "}
              <button
                onClick={() => {
                  short.forEach((s) => onToggleSelected(s.plan));
                  setConfirmClear(false);
                }}
                style={{ background: "none", border: "none", color: C.red, fontSize: 12.5, cursor: "pointer", padding: 0 }}
              >
                Yes, clear it
              </button>{" "}
              &middot;{" "}
              <button
                onClick={() => setConfirmClear(false)}
                style={{ background: "none", border: "none", color: C.blue, fontSize: 12.5, cursor: "pointer", padding: 0 }}
              >
                Never mind
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmClear(true)}
              className="noprint"
              style={{ background: "none", border: "none", color: C.faint, fontSize: 12.5, cursor: "pointer", padding: 0 }}
            >
              Clear shortlist
            </button>
          )}
        </div>
      )}
    </div>
  );
}
