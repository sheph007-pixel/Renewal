import { C, panel } from "@/lib/ui";
import Link from "@/lib/Link";
import type { AccountManager, GroupSignup } from "@/lib/model";
import TeamCard from "@/views/TeamCard";

/** The President of Kennion Benefit Advisors, listed under the account manager on the team card. */
const HUNTER: AccountManager = {
  name: "Hunter Shepherd",
  title: "President, Kennion Benefit Advisors",
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
  optionsHref: string;
  supplementalHref: string;
  signUpHref: string;
  assistantHref: string | null;
  manager: AccountManager | null | undefined;
  lastSignup: GroupSignup | null;
}

/**
 * The Welcome tab for an existing Kennion client. Not a sales letter: they
 * know Kennion and are already in the program. In about twenty seconds the
 * page says that the program expanded for 2027, that BenSync makes the
 * options easier to evaluate, that the client chooses what to offer, and
 * that Kennion handles everything after that. The team card beside it keeps
 * the people reachable without making a call the next step.
 */
export default function Home({ optionsHref, supplementalHref, signUpHref, assistantHref, manager, lastSignup }: Props) {
  const p = { margin: "0 0 14px", fontSize: 15, lineHeight: 1.7, color: C.body, textWrap: "pretty" as const } as const;
  const link = { color: C.blue, fontWeight: 600, textDecoration: "none" } as const;
  const kicker = { margin: "0 0 4px", fontSize: 12, fontWeight: 600, letterSpacing: "0.4px", color: C.faint, textTransform: "uppercase" as const } as const;
  const h = { margin: "0 0 10px", fontSize: 18, fontWeight: 600, color: C.ink, letterSpacing: "-0.2px" } as const;
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
        <div style={{ ...panel, padding: "28px 34px 24px" }}>
          <h2 style={{ ...h, fontSize: 20 }}>Welcome to your 2027 renewal</h2>
          <p style={{ ...p, fontWeight: 600, color: C.ink }}>The Kennion Program is expanding for 2027.</p>
          <p style={p}>
            Kennion has helped employers with employee benefits for more than 50 years, and we have operated the Kennion Program
            since 2013. As the program has grown, and as clients have asked for more choice, we are expanding our group health
            offering with major national partners, networks and programs.
          </p>
          <p style={{ ...p, marginBottom: 0 }}>
            That means more medical plan options, more price points and more flexibility for your group, backed by the same
            Kennion team you already know.
          </p>
        </div>

        <div style={{ ...panel, padding: "24px 34px 22px" }}>
          <p style={kicker}>Meet BenSync</p>
          <h2 style={h}>More options. Smarter, faster decisions.</h2>
          <p style={{ ...p, marginBottom: 0 }}>
            BenSync is Kennion&rsquo;s new benefits decision platform. Review your medical options, model employer contributions,
            compare plans side by side and work with Kennion and the {assistant} to evaluate different strategies, without
            spreadsheets, manual math or unnecessary back-and-forth.
          </p>
        </div>

        <div style={{ ...panel, padding: "24px 34px 22px" }}>
          <p style={kicker}>How it works</p>
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
                  <Link href={s.href} style={{ ...link, fontSize: 15.5 }}>
                    {s.title}
                  </Link>
                  <div style={{ marginTop: 2, fontSize: 14, lineHeight: 1.6, color: C.body, textWrap: "pretty" as const }}>{s.body}</div>
                </div>
              </li>
            ))}
          </ol>
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.rule}` }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 15.5, fontWeight: 600, color: C.ink }}>We handle the rest.</h3>
            <p style={{ ...p, fontSize: 14, marginBottom: 6 }}>
              Once you make your selections, Kennion will coordinate the {HANDLED.slice(0, -1).join(", ")} and {HANDLED[HANDLED.length - 1]}.
            </p>
            <p style={{ ...p, fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 0 }}>You make the decisions. We handle the implementation.</p>
          </div>
        </div>
      </div>

      <div style={{ flex: "0 1 300px", minWidth: 260 }}>
        <TeamCard people={[manager, HUNTER]} note="Questions along the way? Your Kennion team is here throughout the process." />
      </div>
    </div>
  );
}
