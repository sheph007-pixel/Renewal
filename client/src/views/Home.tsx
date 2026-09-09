import { C, h2, num, panel, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";
import { money, type AccountManager, type Group, type GroupSignup } from "@/lib/model";
import NavigatorCard from "@/views/NavigatorCard";
import ContactCard from "@/views/ContactCard";

interface Props {
  g: Group;
  planCount: number;
  enrolled: number;
  monthly: number;
  currentHref: string;
  optionsHref: string;
  supplementalHref: string;
  signUpHref: string;
  manager: AccountManager | null | undefined;
  lastSignup: GroupSignup | null;
}

/** One headline figure, with what it is under it. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, ...num }}>{value}</div>
      <div style={{ marginTop: 2, fontSize: 12.5, color: C.faint }}>{label}</div>
    </div>
  );
}

/**
 * The landing page a client's link now opens. A rate grid used to be the
 * whole site, which left a bookmarked link opening straight into one with no
 * word about what it was, who sent it, or where else to go. This page says
 * that once — what is here, what it costs today, who to call, and where the
 * enrollment detail lives — and then gets out of the way.
 */
export default function Home({
  g,
  planCount,
  enrolled,
  monthly,
  currentHref,
  optionsHref,
  supplementalHref,
  signUpHref,
  manager,
  lastSignup,
}: Props) {
  const card = {
    ...panel,
    padding: "18px 20px",
    display: "block",
    color: "inherit",
    textDecoration: "none",
  };
  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>Your renewal</h2>
      </div>

      <div className="cardgrid">
        <Link href={currentHref} style={card}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.blue }}>
            Current 2026 Medical Plans &rarr;
          </div>
          <p style={{ margin: "6px 0 14px", fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            What your group has today: every plan in force, the rate at each tier, who is enrolled
            on it, and what that comes to a month.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 26 }}>
            <Stat label={planCount === 1 ? "plan in force" : "plans in force"} value={String(planCount)} />
            <Stat label="enrolled" value={String(enrolled)} />
            <Stat label="per month" value={money(monthly)} />
          </div>
        </Link>

        <Link href={optionsHref} style={card}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.blue }}>
            New 2027 Medical Plans &rarr;
          </div>
          <p style={{ margin: "6px 0 14px", fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            What is on the table for January 1, 2027 — the plans quoted for {g.name}, side by side
            with what you pay now, so the difference is the thing you are reading.
          </p>
          <div style={{ fontSize: 12.5, color: C.faint }}>
            Pick the ones you want to talk through and send them over with a note.
          </div>
        </Link>

        <Link href={supplementalHref} style={card}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.blue }}>Supplemental Package &rarr;</div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            Dental, vision, life, disability — whatever else Employee Navigator has {g.name} enrolled in,
            besides medical.
          </p>
        </Link>

        <Link href={signUpHref} style={card}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.blue }}>Sign Up &rarr;</div>
          <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.6, color: C.body }}>
            {lastSignup
              ? `Submitted ${new Date(lastSignup.submittedAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })} — ${lastSignup.plans.length} plan${lastSignup.plans.length === 1 ? "" : "s"}. Send an update any time.`
              : "Shortlist the plans you want to move forward with and send them to your account manager."}
          </p>
        </Link>
      </div>

      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>Anything else</h2>
      </div>
      <div className="cardgrid">
        <NavigatorCard />
        <ContactCard manager={manager} />
      </div>
    </div>
  );
}
