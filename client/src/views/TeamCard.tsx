import { C, panel } from "@/lib/ui";
import type { AccountManager } from "@/lib/model";

/**
 * Your Kennion Team: the account manager first, then anyone else at Kennion
 * the client should know, in one card. Each person carries a direct line,
 * an email and a calendar link, but none of it is the page's call to
 * action: the work happens in BenSync, and the card says the team is there
 * along the way.
 */
export default function TeamCard({ people, note }: { people: (AccountManager | null | undefined)[]; note: string }) {
  const list = people.filter((m): m is AccountManager => !!m && !!m.name);
  if (!list.length) return null;
  const line = { fontSize: 13, color: C.body, lineHeight: 1.8 } as const;
  const link = { color: C.blue, textDecoration: "none" } as const;
  return (
    <div className="noprint" style={{ ...panel, padding: "18px 20px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.4px", color: C.faint, textTransform: "uppercase" }}>Your Kennion Team</div>
      {list.map((m, i) => (
        <div key={m.name} style={{ marginTop: i ? 14 : 10, paddingTop: i ? 14 : 0, borderTop: i ? `1px solid ${C.rule}` : "none" }}>
          <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{m.name}</div>
          {m.title && <div style={{ fontSize: 12.5, color: C.faint }}>{m.title}</div>}
          <div style={{ marginTop: 6 }}>
            {m.phone && (
              <div style={line}>
                Direct{" "}
                <a href={`tel:${m.phone.replace(/[^0-9+]/g, "")}`} style={link}>
                  {m.phone}
                </a>
              </div>
            )}
            {m.email && (
              <div style={line}>
                Email{" "}
                <a href={`mailto:${m.email}`} style={link}>
                  {m.email}
                </a>
              </div>
            )}
            {m.calendly && (
              <div style={line}>
                <a href={m.calendly} target="_blank" rel="noreferrer" style={link}>
                  Schedule A Meeting &#8599;
                </a>
              </div>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.rule}`, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>{note}</div>
    </div>
  );
}
