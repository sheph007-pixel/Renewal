import { RATE_NOTICE_SHORT } from "@/lib/model";
import Link from "@/lib/Link";
import { C } from "@/lib/ui";

/**
 * Site-wide disclaimer. On a group's pages the words come from the admin
 * Welcome Page tab (one per status); elsewhere the standard notice.
 * Deliberately NOT marked `noprint` - it has to appear on the printed
 * reports too, which are what actually get handed around.
 */
export default function Footer({ disclaimersHref, text }: { disclaimersHref?: string; text?: string }) {
  return (
    <div
      style={{
        borderTop: `1px solid ${C.border}`,
        marginTop: 26,
        padding: "16px 22px 24px",
      }}
    >
      <div
        style={{
          maxWidth: 900,
          margin: "0 auto",
          fontSize: 11.5,
          lineHeight: 1.6,
          color: C.faint,
          textAlign: "center",
          textWrap: "pretty",
        }}
      >
        {/* Staff's footer from the Welcome Page tab when set; the standard notice otherwise. */}
        {text || RATE_NOTICE_SHORT}
        {disclaimersHref && (
          <>
            {" "}
            <Link href={disclaimersHref} style={{ color: C.blue, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>
              View Disclaimers
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
