import { C, panel } from "@/lib/ui";
import type { AccountManager } from "@/lib/model";

/**
 * Who to call. Every group is looked after by one account manager, and the
 * question an employer has on these pages — "is this rate right?", "how do I
 * add someone?" — is answered by that person, not by a general inbox. So the
 * card names them, and gives the three ways to reach them: the direct line,
 * email, and a time on their calendar. The same card, with its own label and
 * note, introduces anyone else at Kennion a client should know.
 */
export default function ContactCard({
  manager,
  compact,
  label = "Your account manager",
  note = "Anything about your group — rates, enrollment, a question on these pages — reach out any time.",
}: {
  manager: AccountManager | null | undefined;
  compact?: boolean;
  label?: string;
  note?: string | null;
}) {
  if (!manager || !manager.name) return null;
  const line = { fontSize: 13.5, color: C.body, lineHeight: 1.9 };
  return (
    <div className="noprint" style={{ ...panel, padding: compact ? "14px 16px" : "18px 20px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.4px", color: C.faint, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ marginTop: 8, fontSize: compact ? 15 : 16, fontWeight: 600, color: C.ink }}>
        {manager.name}
      </div>
      {manager.title && <div style={{ fontSize: 12.5, color: C.faint }}>{manager.title}</div>}
      <div style={{ marginTop: 10 }}>
        {manager.phone && (
          <div style={line}>
            Direct{" "}
            <a href={`tel:${manager.phone.replace(/[^0-9+]/g, "")}`} style={{ color: C.blue }}>
              {manager.phone}
            </a>
          </div>
        )}
        {manager.email && (
          <div style={line}>
            Email <a href={`mailto:${manager.email}`} style={{ color: C.blue }}>{manager.email}</a>
          </div>
        )}
        {manager.calendly && (
          <div style={line}>
            <a href={manager.calendly} target="_blank" rel="noreferrer" style={{ color: C.blue }}>
              Schedule a Meeting &#8599;
            </a>
          </div>
        )}
      </div>
      {note && <div style={{ marginTop: 10, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>{note}</div>}
    </div>
  );
}
