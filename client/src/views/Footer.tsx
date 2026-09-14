import { C } from "@/lib/ui";

/**
 * Site-wide disclaimer. Deliberately NOT marked `noprint` — it has to appear on
 * the printed reports too, which are what actually get handed around.
 */
export default function Footer() {
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
        All above rates and benefits are for general information and discussion only. Rates are
        determined by the carrier and are not final until the group is enrolled with the carrier.
        <div style={{ marginTop: 8 }}>
          <span style={{ fontWeight: 700, color: C.muted }}>BenSync</span> · Powered by Kennion Benefit Advisors
        </div>
      </div>
    </div>
  );
}
