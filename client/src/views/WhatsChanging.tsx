import { useMemo } from "react";
import { marketReview, type Group, type KennionData } from "@/lib/model";
import { C, h2, panel, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";

interface Props {
  data: KennionData;
  g: Group;
  optionsHref: string;
}

/**
 * What's New for 2027, under the welcome: one line on where the market
 * review stands and how many options are waiting on Medical Plans. No
 * carrier names, networks or figures here; those belong on Medical Plans.
 */
export default function WhatsChanging({ data, g, optionsHref }: Props) {
  const review = useMemo(() => marketReview(data, g), [data, g]);
  const done = review.complete;
  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>What&rsquo;s New for 2027</h2>
      </div>

      <div style={{ ...panel, padding: "18px 20px" }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: C.body, textWrap: "pretty" as const }}>
          Your current Kennion Program coverage runs through December 31. For January 1, 2027, Kennion has taken your group to
          market across our expanded carrier and program partners. You currently have{" "}
          <strong style={{ color: C.ink }}>
            {review.options} medical plan option{review.options === 1 ? "" : "s"}
          </strong>{" "}
          available to review in BenSync.
        </p>
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <span
            role="status"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              color: done ? C.green : C.amber,
              background: done ? C.greenTint : C.amberTint,
              border: `1px solid ${done ? C.greenEdge : C.amberEdge}`,
            }}
          >
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: "currentColor" }} />
            {done ? "Market review complete: your options are ready to review." : "Market review in progress: additional options may still be added."}
          </span>
          <Link href={optionsHref} style={{ fontSize: 14, fontWeight: 600, color: C.blue, textDecoration: "none" }}>
            Review Medical Options &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
