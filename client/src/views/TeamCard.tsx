import { C, ctaLink, kicker, panel, smallPrimaryBtn } from "@/lib/ui";
import type { AccountManager } from "@/lib/model";
import Link from "@/lib/Link";
import { monogram } from "@/views/SideNav";
import SyncMark from "@/views/SyncMark";

/**
 * The AI Assistant as a member of the team: it sits under the people, with
 * a button that opens the chat box (or the Assistant page when the box is
 * not on this page). Absent when the server cannot answer.
 */
export interface AssistantMember {
  href: string;
  /** Opens the corner chat box; without it the button follows `href`. */
  onOpen?: () => void;
}

interface Props {
  people: (AccountManager | null | undefined)[];
  assistant?: AssistantMember | null;
  note: string;
}

/**
 * Your Kennion Team: the account manager, the licensed broker and the AI
 * Assistant, one card. A navy band at the top makes it read as a team
 * roster rather than a footnote; each member gets an avatar, a role, the
 * ways to reach them and one action. The work still happens in BenSync,
 * and the note at the foot says the team is there along the way.
 */
export default function TeamCard({ people, assistant, note }: Props) {
  const list = people.filter((m): m is AccountManager => !!m && !!m.name);
  if (!list.length && !assistant) return null;
  const line = { fontSize: 13, color: C.body, lineHeight: 1.75 } as const;
  const link = { color: C.blue, textDecoration: "none" } as const;
  const avatar = { display: "grid", placeItems: "center", flex: "none", width: 38, height: 38, borderRadius: "50%", fontSize: 13, fontWeight: 700, letterSpacing: "0.3px" } as const;
  const member = (i: number) => ({ display: "flex", gap: 12, alignItems: "flex-start", padding: "16px 20px", borderTop: i ? `1px solid ${C.rule}` : "none" }) as const;
  const outlineBtn = {
    ...smallPrimaryBtn,
    display: "inline-block",
    marginTop: 8,
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 600,
    color: C.blue,
    background: C.card,
    border: `1px solid ${C.blueEdge}`,
    textDecoration: "none",
  } as const;

  return (
    <div className="noprint" style={{ ...panel, overflow: "hidden", borderColor: C.navy }}>
      <div style={{ padding: "14px 20px 13px", background: C.navy }}>
        <div style={{ ...kicker, color: C.teal }}>Your Kennion Team</div>
        <div style={{ marginTop: 3, fontSize: 15.5, fontWeight: 600, color: C.onColor, letterSpacing: "-0.1px" }}>Here Throughout Your Renewal</div>
      </div>

      {list.map((m, i) => (
        <div key={m.name} style={member(i)}>
          <span aria-hidden="true" style={{ ...avatar, background: C.blueTint, color: C.blueInk, border: `1px solid ${C.blueEdge}` }}>
            {monogram(m.name)}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>{m.name}</div>
            {m.title && <div style={{ fontSize: 12.5, color: C.faint }}>{m.title}</div>}
            <div style={{ marginTop: 5 }}>
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
            </div>
            {m.calendly && (
              <a className="cta" href={m.calendly} target="_blank" rel="noreferrer" style={outlineBtn}>
                Schedule A Meeting &#8599;
              </a>
            )}
          </div>
        </div>
      ))}

      {assistant && (
        <div style={{ ...member(list.length), background: C.zebra }}>
          <span aria-hidden="true" style={{ ...avatar, background: C.navy, color: C.teal }}>
            <SyncMark size={20} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, color: C.ink }}>BenSync AI Assistant</div>
            <div style={{ fontSize: 12.5, color: C.faint }}>AI Assistant · Available Any Time</div>
            <div style={{ ...line, marginTop: 5, lineHeight: 1.55 }}>Instant answers on your plans, your 2027 options and what a contribution would cost.</div>
            {assistant.onOpen ? (
              <button type="button" onClick={assistant.onOpen} style={{ ...smallPrimaryBtn, marginTop: 10, fontWeight: 600 }}>
                Ask The AI Assistant
              </button>
            ) : (
              <Link className="cta" href={assistant.href} style={{ ...smallPrimaryBtn, display: "inline-block", marginTop: 10, fontWeight: 600, textDecoration: "none" }}>
                Ask The AI Assistant
              </Link>
            )}
            <div style={{ marginTop: 6 }}>
              <Link className="cta" href={assistant.href} style={{ ...ctaLink, fontSize: 12.5 }}>
                Open The Assistant Page &rarr;
              </Link>
            </div>
          </div>
        </div>
      )}

      <div style={{ padding: "12px 20px 14px", borderTop: `1px solid ${C.rule}`, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>{note}</div>
    </div>
  );
}
