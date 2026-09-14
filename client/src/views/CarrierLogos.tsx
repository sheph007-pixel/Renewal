import { useEffect, useRef, useState } from "react";
import { C, chip, panel } from "@/lib/ui";
import { carrierSlug, logoUrl, refreshCarrierLogos } from "@/lib/carrier-logos";
import CarrierMark from "@/views/CarrierMark";

interface Row {
  carrier: string;
  slug: string;
  logo: boolean;
}

/**
 * Where staff put each carrier's logo. One upload per carrier — the official
 * file the carrier gives its brokers — and it shows on the options grid, the
 * plan cards and the documents. A carrier without one gets a lettered badge.
 */
export default function CarrierLogos({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bust, setBust] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/carriers/logos");
    if (r.ok) setRows(((await r.json()) as { carriers: Row[] }).carriers);
  };
  useEffect(() => {
    void load();
  }, []);

  const pick = (slug: string) => {
    target.current = slug;
    picker.current?.click();
  };

  const upload = async (file: File) => {
    const slug = target.current;
    if (!slug) return;
    setBusy(slug);
    setError("");
    try {
      const r = await fetch(`/api/admin/carriers/${slug}/logo`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `Upload failed (${r.status})`);
      await refreshCarrierLogos();
      setBust(Date.now());
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (picker.current) picker.current.value = "";
    }
  };

  const remove = async (row: Row) => {
    if (!window.confirm(`Remove the ${row.carrier} logo? The badge shows again until a new one is uploaded.`)) return;
    setBusy(row.slug);
    try {
      await fetch(`/api/admin/carriers/${row.slug}/logo`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      await refreshCarrierLogos();
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Carrier logos</h2>
      <div style={{ marginTop: 4, fontSize: 13, color: C.muted, lineHeight: 1.6, maxWidth: 760 }}>
        Upload each carrier&rsquo;s official logo — the file the carrier gives its brokers — and it shows wherever the carrier is named: the options grid, plan cards, the comparison. PNG or SVG with a transparent background looks best; JPEG and WebP work too. Under 2 MB. Until a carrier has one, its lettered badge shows.
      </div>
      <input ref={picker} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      {error && (
        <div role="alert" style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: C.redTint, border: `1px solid ${C.redEdge}`, color: C.red, fontSize: 12.5 }}>
          {error}
        </div>
      )}
      <div style={{ display: "grid", gap: 10, marginTop: 14, gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))" }}>
        {rows.map((row) => (
          <div key={row.slug} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, background: C.card }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{row.carrier}</span>
              <span style={{ fontSize: 11, color: row.logo ? C.green : C.faint }}>{row.logo ? "Logo on file" : "Badge"}</span>
            </div>
            <div style={{ height: 56, display: "grid", placeItems: "center", background: C.zebra, borderRadius: 6, padding: 8 }}>
              {row.logo ? <img src={logoUrl(row.carrier, bust)} alt={row.carrier} style={{ maxHeight: 40, maxWidth: "100%", objectFit: "contain" }} /> : <CarrierMark name={row.carrier} size={30} withName={false} />}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => pick(carrierSlug(row.carrier))} disabled={busy === row.slug} style={chip(false)}>
                {busy === row.slug ? "Working…" : row.logo ? "Replace" : "Upload logo"}
              </button>
              {row.logo && (
                <button onClick={() => void remove(row)} disabled={busy === row.slug} style={{ ...chip(false), color: C.red }}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
