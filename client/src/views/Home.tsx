import { useState } from "react";
import { C, ctaLink, h2, h3, kicker, panel, primaryBtn } from "@/lib/ui";
import Link from "@/lib/Link";
import { exportChangesPdf, setChatOpen } from "@/lib/chat";
import type { AccountManager, GroupSignup } from "@/lib/model";
import TeamCard from "@/views/TeamCard";
import ProgramStory from "@/views/ProgramStory";

/** The licensed broker on every client's team, used when the server sends no broker contact. */
const HUNTER: AccountManager = {
  name: "Hunter Shepherd",
  title: "President & Licensed Broker",
  phone: "205-641-0469",
  email: "hunter@kennion.com",
  calendly: "https://calendly.com/kennion/call",
};

/** What Kennion takes on once the client has chosen, in the order it happens. */
const HANDLED = [
  "Employee Navigator setup",
  "carrier implementation",
  "employee communications",
  "open enrollment support",
  "employee enrollment assistance",
  "final carrier enrollment",
  "first-month payment",
];

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
 * The button that builds the group's own What's Changing For 2027 summary
 * on the server and saves it through the browser. The PDF is made fresh
 * each time, from the quotes on file at that moment, so it always says what
 * the pages say.
 */
function DownloadChanges({ groupName }: { groupName: string }) {
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
            await exportChangesPdf(groupName);
          } catch (e) {
            setError((e as Error).message || "Could not build the summary. Try again.");
          } finally {
            setBusy(false);
          }
        }}
        style={{ ...primaryBtn, display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600, cursor: busy ? "default" : "pointer", opacity: busy ? 0.7 : 1 }}
      >
        <DownloadIcon />
        {busy ? "Building Your Summary…" : "Download What's Changing (PDF)"}
      </button>
      <span style={{ fontSize: 12.5, color: error ? C.red : C.faint, lineHeight: 1.5 }}>
        {error || "A simple two-page summary of what's new for 2027, ready to share with your team."}
      </span>
    </div>
  );
}

/**
 * The Welcome tab for an existing Kennion client. Not a sales letter: they
 * know Kennion and are already in the program. In about twenty seconds the
 * page says that the program expanded for 2027, that BenSync makes the
 * options easier to evaluate, that the client chooses what to offer, and
 * that Kennion handles everything after that. The What's Changing summary
 * is one click away, the 2027 Kennion Program story (ProgramStory) plays
 * first, at the top of the page, and the team card beside it keeps the
 * people and the AI Assistant reachable without making a call the next step.
 */
export default function Home({ groupName, optionsHref, supplementalHref, signUpHref, assistantHref, manager, broker, lastSignup }: Props) {
  const p = { margin: "0 0 14px", fontSize: 15, lineHeight: 1.7, color: C.body, textWrap: "pretty" as const } as const;
  const link = { color: C.blue, fontWeight: 600, textDecoration: "none" } as const;
  const head = { ...h2, marginBottom: 10, fontSize: 18, letterSpacing: "-0.2px" } as const;
  const assistant = assistantHref ? <Link href={assistantHref} style={link}>AI Assistant</Link> : "AI Assistant";
  const submitted = lastSignup ? new Date(lastSignup.submittedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" }) : null;

  const steps: { title: string; href: string; body: React.ReactNode }[] = [
    { title: "Review Medical Options", href: optionsHref, body: <>See the medical plans Kennion secured for your January 1 effective date.</> },
    { title: "Review Supplemental Benefits", href: supplementalHref, body: <>Review your dental, vision, life and other supplemental options.</> },
    { title: "Build Your Strategy", href: optionsHref, body: <>Compare plans, model contributions and use Kennion and the {assistant} to determine what you want to offer employees.</> },
    {
      title: "Sign Up",
      href: signUpHref,
      body: (
        <>
          When you are ready, tell us which plans you want to offer for 2027.
          {submitted && <> You submitted on {submitted}; you can send an update any time.</>}
        </>
      ),
    },
  ];

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
      <div style={{ flex: "1 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        <ProgramStory />
        <div style={{ ...panel, padding: "28px 34px 24px" }}>
          <h2 style={{ ...head, fontSize: 20 }}>Welcome To Your 2027 Renewal</h2>
          <p style={{ ...p, fontWeight: 600, color: C.ink }}>The Kennion Program is expanding for 2027.</p>
          <p style={p}>
            Kennion has helped employers with employee benefits for more than 50 years, and we have operated the Kennion Program
            since 2013. As the program has grown, and as clients have asked for more choice, we are expanding our group health
            offering with major national partners, networks and programs.
          </p>
          <p style={p}>
            That means more medical plan options, more price points and more flexibility for your group, backed by the same
            Kennion team you already know.
          </p>
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${C.rule}` }}>
            <p style={{ ...kicker, marginBottom: 8 }}>What's Changing From 2026 To 2027</p>
            <DownloadChanges groupName={groupName} />
          </div>
        </div>


        <div style={{ ...panel, padding: "24px 34px 22px" }}>
          <p style={{ ...kicker, marginBottom: 4 }}>How It Works</p>
          <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 14 }}>
            {steps.map((s, i) => (
              <li key={s.title} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                <span
                  aria-hidden="true"
                  style={{ flex: "none", width: 26, height: 26, borderRadius: 13, background: C.blueTint, color: C.blueInk, fontSize: 13, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1 }}
                >
                  {i + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <Link className="cta" href={s.href} style={{ ...ctaLink, fontSize: 15.5 }}>
                    {s.title}
                  </Link>
                  <div style={{ marginTop: 2, fontSize: 14, lineHeight: 1.6, color: C.body, textWrap: "pretty" as const }}>{s.body}</div>
                </div>
              </li>
            ))}
          </ol>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.rule}` }}>
            <h3 style={{ ...h3, marginBottom: 6, fontSize: 15.5 }}>We Handle The Rest.</h3>
            <p style={{ ...p, fontSize: 14, marginBottom: 6 }}>
              Once you make your selections, Kennion will coordinate the {HANDLED.slice(0, -1).join(", ")} and {HANDLED[HANDLED.length - 1]}.
            </p>
            <p style={{ ...p, fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 0 }}>You make the decisions. We handle the implementation.</p>
          </div>
        </div>
      </div>

      <div style={{ flex: "0 1 300px", minWidth: 260 }}>
        <TeamCard
          people={[manager, broker || HUNTER]}
          assistant={assistantHref ? { href: assistantHref, onOpen: () => setChatOpen(true) } : null}
          note="Questions along the way? Your Kennion team is here throughout the process."
        />
      </div>
    </div>
  );
}
