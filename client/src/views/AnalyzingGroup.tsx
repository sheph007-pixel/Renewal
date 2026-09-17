import { useEffect, useState } from "react";
import { TIERS, type CensusProfile, type TierKey } from "@/lib/model";
import { C, num, panel } from "@/lib/ui";

/**
 * What the assistant is looking at while it picks: the group's census as
 * aggregates — employees, average age and spread, the age bands as one
 * short bar chart, who covers family — and the three steps it works
 * through. Shown the moment AI Picks is pressed, so the wait explains the
 * answer; closes itself once the picks are in. Nothing here names a person.
 */
const STEPS = ["Reading your census", "Pricing every quote at your enrollment", "Choosing Lower Cost, Best Fit and Richer Benefits for each carrier"];
const TIER_SHORT: Record<TierKey, string> = { EE: "Employee only", ES: "+ Spouse", EC: "+ Children", FAM: "Family" };

export default function AnalyzingGroup({ profile, counts, enrolled, done, pickCount, onClose }: { profile: CensusProfile | null; counts: Record<TierKey, number>; enrolled: number; done: boolean; pickCount: number; onClose: () => void }) {
  // The steps advance on a clock while the request runs; the last one waits for the answer.
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 1400);
    const t2 = setTimeout(() => setStep(2), 3800);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  const at = done ? STEPS.length : step;
  const maxBand = profile ? Math.max(1, ...profile.bands.map((b) => b.count)) : 1;

  return (
    <div role="dialog" aria-modal="true" aria-label="Analyzing your group" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,24,28,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, width: "min(560px, 100%)", padding: "20px 22px 18px", position: "relative" }}>
        <button onClick={onClose} aria-label="Close" style={{ position: "absolute", top: 10, right: 12, background: "none", border: "none", fontSize: 22, lineHeight: 1, color: C.muted, cursor: "pointer" }}>
          ×
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, background: C.navy, color: "#fff", flex: "none" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
            </svg>
          </span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.navy, lineHeight: 1.2 }}>{done ? `${pickCount} picks ready` : "Analyzing your group"}</div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>{done ? "Opening them in the grid." : "A Lower Cost, Best Fit and Richer Benefits option from each carrier, from your census."}</div>
          </div>
        </div>

        {/* The census, as the assistant sees it. */}
        {profile ? (
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
            <Stat label="Employees" value={String(enrolled)} />
            <Stat label="Average age" value={String(profile.average)} sub={`median ${profile.median}`} />
            <Stat label="Age range" value={`${profile.youngest}–${profile.oldest}`} sub={`${profile.spread} spread`} />
            <Stat label="Dependants" value={String(profile.spouses + profile.children)} sub={`${profile.spouses} spouse${profile.spouses === 1 ? "" : "s"} · ${profile.children} child${profile.children === 1 ? "" : "ren"}`} />
          </div>
        ) : (
          <div style={{ marginTop: 16, fontSize: 13, color: C.muted }}>No ages on file for this group; the picks weigh the quotes alone.</div>
        )}

        {profile && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: 6 }}>Employees by age</div>
            {profile.bands.map((b) => (
              <div key={b.label} style={{ display: "grid", gridTemplateColumns: "64px 1fr 32px", alignItems: "center", gap: 8, marginBottom: 5, fontSize: 12.5, color: C.body }}>
                <span>{b.label}</span>
                <span style={{ display: "block", height: 8, borderRadius: 4, background: C.hairline, overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: `${(b.count / maxBand) * 100}%`, background: C.blue, borderRadius: 4 }} />
                </span>
                <span style={{ textAlign: "right", color: C.ink, ...num }}>{b.count}</span>
              </div>
            ))}
            <div style={{ marginTop: 8, fontSize: 12.5, color: C.muted, ...num }}>
              {TIERS.map((t) => `${TIER_SHORT[t.key]} ${counts[t.key] || 0}`).join(" · ")}
            </div>
          </div>
        )}

        {/* The three steps, and a bar that fills as they complete. */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.hairline}` }}>
          <div style={{ height: 6, borderRadius: 3, background: C.hairline, overflow: "hidden" }}>
            <div className={done ? undefined : "ai-progress"} style={{ height: "100%", width: done ? "100%" : `${Math.max(12, (at / STEPS.length) * 100)}%`, background: C.blue, borderRadius: 3, transition: "width 0.6s ease" }} />
          </div>
          <ol style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 5 }}>
            {STEPS.map((label, i) => {
              const state = i < at ? "done" : i === at ? "now" : "next";
              return (
                <li key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: state === "next" ? C.ghost : C.ink }}>
                  {state === "done" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12.5l4.5 4.5L19 7.5" />
                    </svg>
                  ) : state === "now" ? (
                    <svg className="ai-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.blue} strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                      <path d="M12 3a9 9 0 1 1-6.4 2.6" />
                    </svg>
                  ) : (
                    <span aria-hidden style={{ width: 14, height: 14, borderRadius: 7, border: `1.5px solid ${C.border}`, display: "inline-block" }} />
                  )}
                  {label}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ padding: "8px 10px", borderRadius: 6, background: C.zebra, border: `1px solid ${C.hairline}` }}>
      <div style={{ fontSize: 11.5, color: C.faint }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, lineHeight: 1.2, ...num }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}
