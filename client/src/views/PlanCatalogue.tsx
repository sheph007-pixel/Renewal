import { useEffect, useRef, useState } from "react";
import { C, panel, th, td, num } from "@/lib/ui";
import { carrierSlug } from "@/lib/carrier-logos";
import { money0 } from "@/lib/model";

/** One carrier's standard design, as the server lists it. */
interface CatalogueDesign {
  carrier: string;
  planYear: number;
  planCode: string;
  planId: string | null;
  family: string | null;
  familyName: string | null;
  inNetwork: { deductibleIndividual: number | null; deductibleFamily: number | null; oopMaxIndividual: number | null; oopMaxFamily: number | null };
  outOfNetwork: { deductibleIndividual: number | null; oopMaxIndividual: number | null; coinsurance: number | null };
  deductibleEmbedded: boolean | null;
  services: { label: string; costShare: string | null; deductibleApplies: boolean }[];
  source: string | null;
  updatedAt?: string | null;
}

interface Catalogue {
  carriers: { carrier: string; planYear: number; count: number; sources: string[]; updatedAt: string | null }[];
  designs: CatalogueDesign[];
  durable: boolean;
}

/** The carriers a catalogue can be loaded for: the 2027 lineup. */
const CARRIERS = ["Angle Health", "UnitedHealthcare", "Gravie", "Nationwide"];

const svc = (d: CatalogueDesign, re: RegExp) => d.services.find((s) => re.test(s.label))?.costShare ?? "-";

/**
 * The plan design catalogue: every carrier's standard designs, the same for
 * every group it quotes, and the upload that loads a carrier's workbook.
 * A quoted plan whose name is a catalogue code shows these figures on its
 * card in place of what the reader made of the carrier's PDF.
 */
export default function PlanCatalogue({ token }: { token: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [carrier, setCarrier] = useState(CARRIERS[0]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function load() {
    const r = await fetch("/api/admin/plan-catalogue", { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) setCat(await r.json());
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function upload(f: File) {
    setBusy(true);
    setError("");
    setDone("");
    try {
      const r = await fetch(`/api/admin/plan-catalogue/${carrierSlug(carrier)}?filename=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: f,
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      if (!r.ok) throw new Error(j.error || `Server returned ${r.status}.`);
      setDone(`${j.loaded} ${j.carrier} design(s) loaded; ${j.total} on file for ${j.planYear}.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }

  const shown = cat?.designs.filter((d) => `${d.carrier}|${d.planYear}` === open) || [];

  return (
    <div style={{ ...panel, marginTop: 16, padding: "14px 22px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink }}>Plan Design Catalogue</div>
        <div style={{ fontSize: 12, color: C.faint }}>{cat ? (cat.durable ? "Stored in the database" : "No database: an upload lasts until the next deploy") : ""}</div>
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 840 }}>
        Each carrier quotes the same standard plan designs to every group; only the rates differ. The designs are loaded
        here once, keyed by the carrier's plan code, and every quoted plan with that code takes its deductibles,
        out-of-pocket maximums and benefit lines from the catalogue on every group's plan card and in the assistant's
        figures. Upload a carrier's catalogue workbook (a Plans sheet and a Benefits sheet, one row per plan and per
        service line) to add or replace designs by plan code.
      </div>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13, color: C.body }}>
        <label>
          Carrier{" "}
          <select value={carrier} onChange={(e) => setCarrier(e.target.value)} style={{ padding: "4px 6px", fontSize: 13, border: `1px solid ${C.border}`, borderRadius: 3 }}>
            {CARRIERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={ref}
          type="file"
          accept=".xlsx"
          aria-label="Plan design catalogue workbook"
          disabled={busy}
          onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
        />
        {busy && <span style={{ color: C.faint }}>Loading…</span>}
        {done && <span style={{ color: C.green }}>{done}</span>}
        {error && <span style={{ color: C.red }}>{error}</span>}
      </div>
      {cat && !cat.carriers.length && <div style={{ marginTop: 10, fontSize: 13, color: C.faint }}>No catalogue loaded yet.</div>}
      {cat && cat.carriers.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr>
              <th style={th}>Carrier</th>
              <th style={th}>Plan year</th>
              <th style={{ ...th, textAlign: "right" }}>Designs</th>
              <th style={th}>Source</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {cat.carriers.map((c) => {
              const key = `${c.carrier}|${c.planYear}`;
              return (
                <tr key={key}>
                  <td style={td}>{c.carrier}</td>
                  <td style={td}>{c.planYear}</td>
                  <td style={{ ...td, textAlign: "right", ...num }}>{c.count}</td>
                  <td style={{ ...td, color: C.faint }}>{c.sources.join(", ") || "-"}</td>
                  <td style={td}>
                    <button type="button" onClick={() => setOpen(open === key ? null : key)} style={{ background: "none", border: 0, color: C.blue, cursor: "pointer", fontSize: 13, padding: 0 }}>
                      {open === key ? "Hide designs" : "Show designs"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {shown.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={th}>Plan code</th>
                <th style={th}>Family</th>
                <th style={{ ...th, textAlign: "right" }}>Deductible</th>
                <th style={{ ...th, textAlign: "right" }}>OOP max</th>
                <th style={th}>PCP</th>
                <th style={th}>Specialist</th>
                <th style={th}>Urgent care</th>
                <th style={th}>ER</th>
                <th style={th}>Inpatient</th>
                <th style={th}>Rx tiers 1-4</th>
                <th style={{ ...th, textAlign: "right" }}>OON deductible</th>
                <th style={th}>Embedded</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.planCode}>
                  <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 600 }}>{d.planCode}</td>
                  <td style={td}>{d.familyName || d.family || "-"}</td>
                  <td style={{ ...td, textAlign: "right", ...num }}>
                    {money0(d.inNetwork.deductibleIndividual)} / {money0(d.inNetwork.deductibleFamily)}
                  </td>
                  <td style={{ ...td, textAlign: "right", ...num }}>
                    {money0(d.inNetwork.oopMaxIndividual)} / {money0(d.inNetwork.oopMaxFamily)}
                  </td>
                  <td style={td}>{svc(d, /primary care/i)}</td>
                  <td style={td}>{svc(d, /specialist/i)}</td>
                  <td style={td}>{svc(d, /urgent/i)}</td>
                  <td style={td}>{svc(d, /emergency/i)}</td>
                  <td style={td}>{svc(d, /inpatient/i)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    {[/tier 1/i, /tier 2/i, /tier 3/i, /tier 4/i].map((re) => svc(d, re)).join(" / ")}
                  </td>
                  <td style={{ ...td, textAlign: "right", ...num }}>
                    {money0(d.outOfNetwork.deductibleIndividual)}
                    {d.outOfNetwork.coinsurance != null ? ` · ${Math.round(d.outOfNetwork.coinsurance * 100)}%` : ""}
                  </td>
                  <td style={td}>{d.deductibleEmbedded == null ? "-" : d.deductibleEmbedded ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
