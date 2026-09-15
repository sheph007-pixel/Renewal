import { useState } from "react";
import { money } from "@/lib/model";
import {
  CARRIERS,
  FREQUENCIES,
  SUPPLEMENTAL_FOOTNOTE,
  SUPPLEMENTAL_SECTIONS,
  SUPPLEMENTAL_TIERS,
  convertRate,
  downloadSupplementalSheet,
  frequencyLabel,
  type Frequency,
} from "@/lib/supplemental";
import { C, chip, h2, num, panel, sectionHead, th } from "@/lib/ui";

/**
 * The Kennion supplemental package — one rate grid per product line, each
 * with the carrier's provider search beside its heading. The rates are the
 * same for every group, so this page takes no group data; the only state is
 * the pay frequency the rates are shown at.
 */
export default function SupplementalPackage() {
  const [freq, setFreq] = useState<Frequency>("monthly");
  const [busy, setBusy] = useState(false);

  const headCell = { ...th, background: C.headerBg, color: "#fff", borderBottom: "none", padding: "11px 10px" };
  const cell = { padding: "10px 10px", borderBottom: `1px solid ${C.hairline}`, fontSize: 14, background: C.card };
  const numCell = { ...cell, textAlign: "right" as const, ...num };

  /** The carrier's provider search, on the grids where a client looks one up: Guardian's on dental, VSP's on vision. */
  const providerLink = (s: { product: string; carrier: string }) => (/dental|vision/i.test(s.product) ? CARRIERS.find((c) => c.name.toLowerCase().startsWith(s.carrier.toLowerCase())) ?? null : null);

  async function exportExcel() {
    setBusy(true);
    try {
      await downloadSupplementalSheet(freq);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className="anchor"
        style={{ ...sectionHead, display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}
      >
        <h2 style={h2}>Supplemental Package</h2>
        <div className="noprint" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <div role="group" aria-label="Pay frequency" style={{ display: "flex", gap: 4 }}>
            {FREQUENCIES.map((f) => (
              <button key={f.key} type="button" aria-pressed={freq === f.key} style={chip(freq === f.key)} onClick={() => setFreq(f.key)}>
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void exportExcel()}
            style={{
              padding: "7px 14px",
              fontSize: 13,
              fontWeight: 500,
              color: C.ink,
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              cursor: busy ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {busy ? "Preparing…" : "Export To Excel"}
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, color: C.muted, margin: "0 0 10px" }}>
        Showing <strong style={{ color: C.ink, fontWeight: 600 }}>{frequencyLabel(freq)}</strong> rates
        {freq !== "monthly" ? " (monthly × 12 ÷ pay periods, rounded to the cent)" : ""}.
      </div>

      {SUPPLEMENTAL_SECTIONS.map((s) => (
        <div key={s.id} style={{ marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, margin: "0 0 6px" }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink }}>
              {s.product} <span style={{ color: C.faint, fontWeight: 400 }}>·</span> {s.carrier}
            </div>
            {providerLink(s) && (
              <a className="noprint" href={providerLink(s)!.href} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 500, color: C.blue, background: C.card, border: `1px solid ${C.border}`, borderRadius: 4, padding: "4px 10px", textDecoration: "none", whiteSpace: "nowrap" }}>
                {providerLink(s)!.linkLabel} ↗
              </a>
            )}
          </div>
          <div className="panel" style={{ ...panel, padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                <thead>
                  <tr>
                    <th style={{ ...headCell, textAlign: "left", paddingLeft: 14 }}>Plan</th>
                    {SUPPLEMENTAL_TIERS.map((t) => (
                      <th key={t.key} style={{ ...headCell, textAlign: "right" }}>
                        {t.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((row) => (
                    <tr key={row.plan}>
                      <td style={{ ...cell, paddingLeft: 14, fontWeight: 500, color: C.ink }}>{row.plan}</td>
                      {SUPPLEMENTAL_TIERS.map((t) => {
                        const v = row[t.key];
                        return (
                          <td key={t.key} style={{ ...numCell, color: v == null ? C.ghost : C.ink }}>
                            {v == null ? "—" : money(convertRate(v, freq))}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}

      <p style={{ margin: "4px 0 0", fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>{SUPPLEMENTAL_FOOTNOTE}</p>
    </div>
  );
}
