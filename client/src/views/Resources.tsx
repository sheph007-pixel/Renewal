import { useEffect, useState } from "react";
import { C, h2, h3, panel, sectionHead } from "@/lib/ui";
import CarrierMark from "@/views/CarrierMark";

/** One piece of marketing material, as the server lists it - metadata only, the file is fetched separately when opened. */
interface Resource {
  id: number;
  carrier: string;
  title: string;
  summary: string | null;
  filename: string;
  mime: string;
  size: number;
  uploadedAt: string;
}

const fileBadge = (mime: string, filename: string) => {
  if (/pdf/i.test(mime) || /\.pdf$/i.test(filename)) return "PDF";
  if (/word|docx?$/i.test(mime) || /\.docx?$/i.test(filename)) return "DOC";
  if (/sheet|excel|xlsx?$/i.test(mime) || /\.xlsx?$/i.test(filename)) return "XLS";
  if (/^image\//.test(mime)) return "IMG";
  return "FILE";
};

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

/** One resource card: title, a one-line summary where Claude gave one, and a download link. */
function ResourceCard({ r }: { r: Resource }) {
  return (
    <a
      href={`/api/resources/${r.id}/file`}
      target="_blank"
      rel="noreferrer"
      style={{
        ...panel,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "14px 16px",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, lineHeight: 1.35 }}>{r.title}</div>
        <span
          aria-hidden
          style={{ flex: "none", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.3px", color: C.blueInk, background: C.blueTint, border: `1px solid ${C.blueEdge}`, borderRadius: 4, padding: "2px 6px" }}
        >
          {fileBadge(r.mime, r.filename)}
        </span>
      </div>
      {r.summary && <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{r.summary}</div>}
      <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: C.blue }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3v13m0 0-4-4m4 4 4-4" />
          <path d="M4 17v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        Download
        <span style={{ marginLeft: "auto", fontWeight: 400, color: C.faint }}>{fmtSize(r.size)}</span>
      </div>
    </a>
  );
}

/**
 * Resources: marketing material from each Carrier/TPA Kennion works with -
 * broker decks, one-pagers, FAQs - grouped by vendor. Staff upload a file in
 * the admin and Claude files it under the right vendor immediately; this
 * page just reads what is on file, so it takes no group data and reads the
 * same for every group.
 */
export default function Resources() {
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/resources")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: { resources: Resource[] }) => {
        if (alive) setResources(j.resources || []);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const groups = new Map<string, Resource[]>();
  for (const r of resources || []) groups.set(r.carrier, [...(groups.get(r.carrier) || []), r]);
  // Vendors with material first, alphabetically; "Other" (material about no one carrier) last.
  const carriers = [...groups.keys()].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));

  return (
    <div>
      <div className="anchor" style={sectionHead}>
        <h2 style={h2}>Resources</h2>
      </div>
      <p style={{ maxWidth: 720, marginTop: -6, marginBottom: 20, fontSize: 13.5, color: C.body, lineHeight: 1.6 }}>
        Broker decks, one-page overviews and FAQs from the Carriers/TPAs Kennion works with - here to help you learn more
        about a partner, not to replace the figures on your Medical Plans page.
      </p>

      {error && <div style={{ ...panel, padding: "14px 18px", fontSize: 13.5, color: C.muted }}>Resources could not be loaded. Try again in a moment.</div>}
      {!error && resources == null && <div style={{ fontSize: 13.5, color: C.muted }}>Loading…</div>}
      {!error && resources != null && !resources.length && (
        <div style={{ ...panel, padding: "14px 18px", fontSize: 13.5, color: C.muted }}>Nothing on file yet - check back as more material is added.</div>
      )}

      {carriers.map((carrier) => (
        <section key={carrier} style={{ marginBottom: 26 }}>
          <div style={{ marginBottom: 10 }}>
            {carrier === "Other" ? (
              <h3 style={h3}>Other</h3>
            ) : (
              <CarrierMark name={carrier} withName size={22} fontSize={15} color={C.ink} />
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
            {groups.get(carrier)!.map((r) => (
              <ResourceCard key={r.id} r={r} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
