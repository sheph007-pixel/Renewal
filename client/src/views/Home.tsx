import { C, panel } from "@/lib/ui";
import Link from "@/lib/Link";
import type { Group, GroupSignup } from "@/lib/model";

const CALENDLY = "https://calendly.com/kennion/call";

interface Props {
  g: Group;
  currentHref: string;
  optionsHref: string;
  supplementalHref: string;
  signUpHref: string;
  changesHref: string;
  lastSignup: GroupSignup | null;
}

/**
 * The Welcome tab: a short note from the President of Kennion Benefit
 * Advisors to the employer, saying what is happening for 2027, how this site
 * is laid out, and how to get a call on the calendar. Nothing else lives here.
 */
export default function Home({ g, currentHref, optionsHref, supplementalHref, signUpHref, changesHref, lastSignup }: Props) {
  const p = { margin: "0 0 16px", fontSize: 15.5, lineHeight: 1.75, color: C.body } as const;
  const link = { color: C.blue, fontWeight: 600, textDecoration: "none" } as const;
  const li = { margin: "0 0 8px" } as const;
  return (
    <div style={{ ...panel, padding: "34px 40px 30px" }}>
      <p style={p}>Hello {g.name} team,</p>
      <p style={p}>
        Thank you for being a Kennion client. Due to our continued growth and demand, our program is moving
        to a number of major national partners and networks for 2027, and that opens up an expanded set of
        options for your group.
      </p>
      <p style={{ ...p, marginBottom: 10 }}>This site organizes everything for your 2027 Employee Benefits Program:</p>
      <ol style={{ margin: "0 0 16px", paddingLeft: 26, fontSize: 15.5, lineHeight: 1.75, color: C.body }}>
        <li style={li}>
          <Link href={changesHref} style={link}>What&rsquo;s Changing For 2027</Link> &mdash; the headline: today against 2027.
        </li>
        <li style={li}>
          <Link href={currentHref} style={link}>Your 2026 Medical Plans</Link> &mdash; what your group has in force today.
        </li>
        <li style={li}>
          <Link href={optionsHref} style={link}>New 2027 Medical Options</Link> &mdash; the plans quoted for {g.name}, side by side.
        </li>
        <li style={li}>
          <Link href={supplementalHref} style={link}>Supplemental Package</Link> &mdash; dental, life, accident, critical illness,
          cancer, hospital indemnity, and short term disability with Guardian, and vision with VSP.
        </li>
      </ol>
      <p style={p}>
        Once you are ready, <Link href={signUpHref} style={link}>Sign Up</Link> starts the setup process with your account
        manager, so everything is in place for open enrollment and a January 1, 2027 effective date.
        {lastSignup && (
          <>
            {" "}You submitted on{" "}
            {new Date(lastSignup.submittedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}; you can send an
            update any time.
          </>
        )}
      </p>
      <p style={p}>
        If you would like to talk any of it through, I would be glad to.{" "}
        <a href={CALENDLY} target="_blank" rel="noreferrer" style={link}>
          Schedule a call with me &rarr;
        </a>
      </p>
      <p style={{ ...p, marginTop: 26, marginBottom: 0 }}>
        Hunter Shepherd
        <br />
        <span style={{ fontSize: 13.5, color: C.muted }}>President, Kennion Benefit Advisors</span>
      </p>
    </div>
  );
}
