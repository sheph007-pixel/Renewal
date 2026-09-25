import { useState } from "react";
import { C, ctaLink, h2, h3, kicker, Logo, panel, primaryBtn } from "@/lib/ui";
import Link from "@/lib/Link";
import { exportChangesPdf, setChatOpen } from "@/lib/chat";
import { effectiveDateLabel, effectiveYear, paragraphsOf, type AccountManager, type GroupSignup, type WelcomeCopy } from "@/lib/model";
import TeamCard from "@/views/TeamCard";
import { useNarrow } from "@/lib/narrow";

interface Props {
  groupName: string;
  optionsHref: string;
  supplementalHref: string;
  signUpHref: string;
  assistantHref: string | null;
  manager: AccountManager | null | undefined;
  /** The licensed broker, from the server; HUNTER when it sends none. */
  broker?: AccountManager | null;
  lastSignup: GroupSignup | null;
  /** The date this group's elections take effect. Falls back to the system default when unset. */
  effectiveDate?: string;
  /** Renewing prior coverage, or enrolling with Kennion for the first time. */
  groupStatus?: "new" | "existing";
  /** The group's name as its pages show it (a display name staff set, or the official one). */
  shownName?: string;
  /** Staff's wording for the effective date, when set. Copy only. */
  effectiveDateLabel?: string | null;
  /** The page's words for this group's status, from the admin Welcome Page tab. */
  welcome?: WelcomeCopy;
}

/** A small arrow-down-into-tray icon for the download button. */
function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11M7 10l5 5 5-5" />
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

/**
 * The button that builds the group's own Program Overview on the server and
 * saves it through the browser. The PDF is made fresh each time, from the
 * quotes on file at that moment, so it always says what the pages say. The
 * year names the download itself, not the button or caption text - the
 * Effective Date line above already says when.
 */
function DownloadChanges({ groupName, year }: { groupName: string; year: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await exportChangesPdf(groupName, year);
          } catch (e) {
            setError((e as Error).message || "Could not build the summary. Try again.");
          } finally {
            setBusy(false);
          }
        }}
        style={{ ...primaryBtn, display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
      >
        <DownloadIcon />
        {busy ? "Building Your Overview…" : "Download Program Overview"}
      </button>
      {error && (
        <span style={{ fontSize: 12.5, color: C.red, lineHeight: 1.5 }}>{error}</span>
      )}
    </div>
  );
}

/**
 * The Welcome tab. Its words - headline, intro, the four How It Works steps,
 * the closing section and the team card's note - are written once per status
 * (Existing, New) on the admin Welcome Page tab; a blank field shows nothing,
 * and a blank line starts a new paragraph. What stays dynamic is the group's
 * own: its name and effective date, where each step links, when it last
 * submitted, and its team. The year's Program Overview is one click away. Then How It Works: four numbered boxes in a row
 * (wrapping on a narrow screen), not a stacked list - the natural left-to-
 * right reading order already says 1, 2, 3, 4, and a row takes a fraction
 * of the height four stacked rows would. No sales carousel, no separate
 * "what's new" section - a returning client can see their own option count
 * on Medical Plans instead of a second summary of it here. The team card
 * beside it keeps the people and the AI Assistant reachable without making
 * a call the next step.
 */
export default function Home({ groupName, optionsHref, supplementalHref, signUpHref, assistantHref, manager, lastSignup, effectiveDate, shownName, effectiveDateLabel: dateLabel, welcome }: Props) {
  const narrow = useNarrow();
  const p = { margin: "0 0 14px", fontSize: 15, lineHeight: 1.7, color: C.body, textWrap: "pretty" as const } as const;
  const link = { color: C.blue, fontWeight: 600, textDecoration: "none" } as const;
  const head = { ...h2, marginBottom: 10, fontSize: 18, letterSpacing: "-0.2px" } as const;
  const submitted = lastSignup ? new Date(lastSignup.submittedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;
  const headline = (welcome?.headline || "").trim();
  const intro = paragraphsOf(welcome?.intro);
  const closing = paragraphsOf(welcome?.closingBody);
  const tagline = (welcome?.closingTagline || "").trim();
  const eff = { effectiveDate, effectiveDateLabel: dateLabel };
  const year = effectiveYear(eff);

  // "AI Assistant" in a step's words links to the assistant when it is on.
  const withAssistant = (text: string): React.ReactNode => {
    const at = text.indexOf("AI Assistant");
    if (!assistantHref || at < 0) return text;
    return (
      <>
        {text.slice(0, at)}
        <Link href={assistantHref} style={link}>AI Assistant</Link>
        {text.slice(at + "AI Assistant".length)}
      </>
    );
  };
  // Where each step goes is fixed; only its words come from the copy.
  const hrefs = [optionsHref, supplementalHref, optionsHref, signUpHref];
  const steps: { title: string; href: string; body: React.ReactNode }[] = (welcome?.steps || []).slice(0, 4).map((st, i) => ({
    title: st.title,
    href: hrefs[i],
    body: (
      <>
        {withAssistant(st.body)}
        {i === 3 && submitted && <> Submitted {submitted}; send an update any time.</>}
      </>
    ),
  }));

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
      <div style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ ...panel, padding: narrow ? "20px 18px 18px" : "28px 34px 24px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
            <h2 style={{ ...head, fontSize: 20 }}>Welcome, {shownName || groupName}</h2>
            <img src={Logo} alt="Kennion Benefit Advisors" style={{ flex: "none", height: 28, marginTop: 2 }} />
          </div>
          <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: C.ink }}>Effective Date: {effectiveDateLabel(eff)}</p>
          {headline && <p style={{ ...p, fontWeight: 600, color: C.ink, ...(intro.length ? {} : { marginBottom: 0 }) }}>{headline}</p>}
          {intro.map((t, i) => (
            <p key={i} style={{ ...p, whiteSpace: "pre-line", ...(i === intro.length - 1 ? { marginBottom: 0 } : {}) }}>{t}</p>
          ))}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.rule}` }}>
            <p style={{ ...kicker, marginBottom: 8 }}>Program Overview</p>
            <DownloadChanges groupName={groupName} year={year} />
          </div>
        </div>

        <div style={{ ...panel, padding: narrow ? "18px 18px 16px" : "20px 26px 20px" }}>
          <p style={{ ...kicker, marginBottom: 10 }}>How It Works</p>
          <ol
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "grid",
              // Always exactly 4 equal columns on a normal-width screen - not
              // auto-fit, which can silently drop to fewer, unevenly-sized
              // columns depending on the viewport. Only the narrow/mobile
              // breakpoint stacks them.
              gridTemplateColumns: narrow ? "1fr" : "repeat(4, 1fr)",
              gap: 10,
            }}
          >
            {steps.map((s, i) => (
              <li key={s.title} style={{ minWidth: 0, height: "100%", display: "flex", flexDirection: "column" }}>
                {/* Step number sits above the card, outside its border and padding -
                    a small overline, not competing with the title for width or its
                    own line inside the box. The title is free to wrap to a second
                    line instead of truncating with an ellipsis; the grid row already
                    stretches every <li> in it to the tallest one's height, so all 4
                    cards still end up the same height even when one title wraps and
                    the others don't. */}
                <div
                  aria-hidden="true"
                  style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.5px", color: C.blueInk, textTransform: "uppercase", marginBottom: 4 }}
                >
                  Step {i + 1}
                </div>
                {/* The whole card is the link, not just the title - .rowlink darkens
                    the background on hover so the card reads as clickable wherever
                    the pointer lands on it, not just over the two words of the title.
                    flex: 1 1 auto fills the remaining height in the <li> below the
                    step number, so the card's own bottom edges still line up. */}
                <Link
                  className="rowlink card-link"
                  href={s.href}
                  style={{
                    display: "block",
                    flex: "1 1 auto",
                    boxSizing: "border-box",
                    padding: "11px 10px 10px",
                    borderRadius: 8,
                    background: C.zebra,
                    border: `1px solid ${C.hairline}`,
                    textDecoration: "none",
                    cursor: "pointer",
                  }}
                >
                  {/* An explicit line break (\n) in the title, not the browser's own
                      wrapping - whiteSpace: pre-line respects it so all 4 cards break
                      at the same intentional spot instead of wherever the column
                      happens to be narrow enough to force a wrap. */}
                  <div className="cta" style={{ ...ctaLink, display: "block", fontSize: 15.5, lineHeight: 1.25, letterSpacing: "-0.2px", marginBottom: 5, whiteSpace: "pre-line" }}>
                    {s.title}
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: C.body, textWrap: "pretty" as const }}>{s.body}</div>
                </Link>
              </li>
            ))}
          </ol>
          {(welcome?.closingHeading || closing.length > 0 || tagline) && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.rule}` }}>
              {welcome?.closingHeading && <h3 style={{ ...h3, marginBottom: 6, fontSize: 15.5 }}>{welcome.closingHeading}</h3>}
              {closing.map((t, i) => (
                <p key={i} style={{ ...p, fontSize: 14, marginBottom: i === closing.length - 1 && !tagline ? 0 : 6, whiteSpace: "pre-line" }}>{t}</p>
              ))}
              {tagline && <p style={{ ...p, fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 0 }}>{tagline}</p>}
            </div>
          )}
        </div>
      </div>

      <div style={{ flex: "0 1 300px", minWidth: 260 }}>
        <TeamCard
          people={[manager]}
          assistant={assistantHref ? { href: assistantHref, onOpen: () => setChatOpen(true) } : null}
          note={welcome?.teamNote || undefined}
        />
      </div>
    </div>
  );
}
