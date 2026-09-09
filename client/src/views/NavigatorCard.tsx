import { C, panel } from "@/lib/ui";

/** Where employers administer the group day to day. */
export const NAVIGATOR_URL = "https://goenroll.employeenavigator.com/";

/**
 * These pages say what the group has and what 2027 looks like; Employee
 * Navigator is where the underlying detail lives — every enrolled employee,
 * their plan and tier, dependants, effective dates, and the plan documents.
 * An employer who wants to go past the summary should not have to hunt for the
 * address, so it sits on the page that prompts the question.
 */
export default function NavigatorCard({ compact }: { compact?: boolean }) {
  return (
    <div className="noprint" style={{ ...panel, padding: compact ? "14px 16px" : "18px 20px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.4px", color: C.faint, textTransform: "uppercase" }}>
        Employee Navigator
      </div>
      <div style={{ marginTop: 8, fontSize: compact ? 15 : 16, fontWeight: 600, color: C.ink }}>
        See everything on your group
      </div>
      <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.65, color: C.body }}>
        Sign in to Employee Navigator with your usual administrator login to see who is enrolled,
        on which plan and tier, their dependants and effective dates, and your plan documents. It
        is also where you add a new hire or make a change during the year.
      </p>
      <a
        href={NAVIGATOR_URL}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-block",
          marginTop: 12,
          padding: "8px 16px",
          fontSize: 13.5,
          fontWeight: 500,
          color: "#fff",
          background: C.blue,
          border: `1px solid ${C.blue}`,
          borderRadius: 4,
          textDecoration: "none",
        }}
      >
        Log in to Employee Navigator &#8599;
      </a>
      <div style={{ marginTop: 9, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
        Don&rsquo;t have a login, or can&rsquo;t get in? Your account manager can set one up.
      </div>
    </div>
  );
}
