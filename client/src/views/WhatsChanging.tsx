import { useMemo } from "react";
import { effectiveDateLabel, effectiveYear, marketReview, type Group, type KennionData } from "@/lib/model";
import { C, h2, panel, primaryBtn, sectionHead } from "@/lib/ui";
import Link from "@/lib/Link";

interface Props {
  data: KennionData;
  g: Group;
  optionsHref: string;
}

/**
 * What's New, under the welcome: how many options are waiting on Medical
 * Plans and one large button to get there. No carrier names, networks or
 * figures here; those belong on Medical Plans. Shown only to a group that
 * already has prior coverage to compare against - a new group has nothing
 * "changing" from, so App.tsx does not render this for one.
 */
export default function WhatsChanging({ data, g, optionsHref }: Props) {
  const review = useMemo(() => marketReview(data, g), [data, g]);
  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>What&rsquo;s New For {effectiveYear(g)}</h2>
      </div>

      <div style={{ ...panel, padding: "18px 20px" }}>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: C.body, textWrap: "pretty" as const }}>
          Your current Kennion Program coverage runs through December 31. For {effectiveDateLabel(g)}, Kennion has taken your group to
          market across our expanded carrier and program partners. You currently have{" "}
          <strong style={{ color: C.ink }}>
            {review.options} medical plan option{review.options === 1 ? "" : "s"}
          </strong>{" "}
          available to review in BenSync.
        </p>
        <div style={{ marginTop: 18 }}>
          <Link
            className="cta"
            href={optionsHref}
            style={{
              ...primaryBtn,
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "14px 28px",
              fontSize: 16,
              fontWeight: 600,
              borderRadius: 6,
              textDecoration: "none",
            }}
          >
            Review Medical Options &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
