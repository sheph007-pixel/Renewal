import { money, money0, type AccountManager, type Group } from "@/lib/model";
import { C, h2, num, panel, sectionHead, th } from "@/lib/ui";
import NavigatorCard from "@/views/NavigatorCard";
import ContactCard from "@/views/ContactCard";

interface Props {
  g: Group;
  manager: AccountManager | null | undefined;
}

/**
 * Everything besides medical: dental, vision, life, disability, whatever else
 * Employee Navigator has the group enrolled in. Group totals only — no member
 * detail, the same rule as every other client page.
 */
export default function SupplementalPackage({ g, manager }: Props) {
  const lines = g.lines || [];
  const cell = { padding: "12px 10px", borderBottom: `1px solid ${C.hairline}`, fontSize: 14 };
  const numCell = { ...cell, textAlign: "right" as const, ...num };

  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>Supplemental Package</h2>
      </div>

      {!g.linesLoaded ? (
        <div style={{ ...panel, padding: "20px 22px" }}>
          <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.65 }}>
            We don&rsquo;t have your dental, vision, life or disability lines loaded yet — that comes in with
            your next Employee Navigator export. If your group carries any of these, they&rsquo;re already
            visible in Employee Navigator itself, or ask{" "}
            {manager?.name ? manager.name.split(" ")[0] : "your account manager"} and we&rsquo;ll get it filled
            in here.
          </p>
        </div>
      ) : lines.length === 0 ? (
        <div style={{ ...panel, padding: "20px 22px" }}>
          <p style={{ margin: 0, fontSize: 13.5, color: C.body, lineHeight: 1.65 }}>
            No supplemental benefits on file for {g.name} — medical only, as far as your latest Employee
            Navigator export shows. If that&rsquo;s not right, let{" "}
            {manager?.name ? manager.name.split(" ")[0] : "your account manager"} know.
          </p>
        </div>
      ) : (
        <div style={{ ...panel, padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: "left", padding: "11px 10px 11px 14px", background: C.ink, color: "#fff", borderBottom: "none" }}>
                    Benefit
                  </th>
                  <th style={{ ...th, textAlign: "left", padding: "11px 10px", background: C.ink, color: "#fff", borderBottom: "none" }}>
                    Plan
                  </th>
                  <th style={{ ...th, textAlign: "left", padding: "11px 10px", background: C.ink, color: "#fff", borderBottom: "none" }}>
                    Carrier
                  </th>
                  <th style={{ ...th, textAlign: "right", padding: "11px 10px", background: C.ink, color: "#fff", borderBottom: "none" }}>
                    Enrolled
                  </th>
                  <th style={{ ...th, textAlign: "right", padding: "11px 14px 11px 10px", background: C.ink, color: "#fff", borderBottom: "none" }}>
                    Monthly
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={`${l.benefit}-${l.plan}-${i}`} style={{ background: i % 2 ? C.zebra : "#fff" }}>
                    <td style={{ ...cell, paddingLeft: 14, fontWeight: 600, color: C.ink }}>{l.benefit}</td>
                    <td style={cell}>{l.plan}</td>
                    <td style={{ ...cell, color: C.body }}>{l.carrier}</td>
                    <td style={numCell}>{l.enrolled}</td>
                    <td style={{ ...numCell, paddingRight: 14, fontWeight: 600, color: C.ink }}>{money0(l.monthly)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} style={{ padding: "12px 10px 12px 14px", fontSize: 14, fontWeight: 600, color: C.ink }}>
                    Total supplemental
                  </td>
                  <td style={{ padding: "12px 14px 12px 10px", textAlign: "right", fontSize: 16, fontWeight: 600, color: C.ink, ...num }}>
                    {money(g.supplementalMonthly ?? 0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <div className="cardgrid" style={{ marginTop: 22 }}>
        <NavigatorCard />
        <ContactCard manager={manager} />
      </div>
    </div>
  );
}
