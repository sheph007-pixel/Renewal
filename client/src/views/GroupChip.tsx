import { C } from "@/lib/ui";
import { shownName, type Group } from "@/lib/model";

/**
 * The client's name, as a small pill - the same size, in the same top-right
 * spot, on every page that shows it (Medical Plans, Supplemental Package,
 * Sign Up). It says which group without repeating the page's own title,
 * which the shared page header already carries.
 */
export default function GroupChip({ g }: { g: Group }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 14px 5px 5px", borderRadius: 20, background: C.zebra, border: `1px solid ${C.hairline}`, maxWidth: "100%" }}>
      <span aria-hidden style={{ flex: "none", display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: "50%", background: C.navy, color: "#fff", fontSize: 11, fontWeight: 700 }}>
        {shownName(g)
          .replace(/[^A-Za-z0-9 ]/g, " ")
          .split(/\s+/)
          .filter((w) => w && !/^(inc|llc|co|corp|corporation|company|the|of|and)$/i.test(w))
          .slice(0, 2)
          .map((w) => w[0])
          .join("")
          .toUpperCase()}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shownName(g)}</span>
    </div>
  );
}
