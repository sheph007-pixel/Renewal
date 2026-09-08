import { useState } from "react";
import { C, money0, panel } from "@/lib/importui";
import Link from "@/lib/Link";
import { PATHS } from "@/lib/router";
import { BROKER_LABEL, RENEWALS, RENEWAL_LABEL, RENEWAL_TONE, type AdminGroup } from "@/views/GroupsTable";
import { GroupProposals } from "@/views/Proposals";
import { GroupBilling } from "@/views/Funding";

interface Props {
  group: AdminGroup & {
    tpa?: string;
    plans?: { plan: string; tpa: string; enrolled: number; monthly: number }[];
    pyStart?: string | null;
    pyEnd?: string | null;
    corporationType?: string | null;
    situsState?: string | null;
    editedFields?: string[];
  };
  token: string;
  onChanged: (groups: AdminGroup[]) => void;
  /** Return to the Groups list (after an archive, for instance). */
  onBack: () => void;
  /** Called before following the link to Plans & Rates, so it opens filtered to this group. */
  onOpenRates: (name: string) => void;
  /** The month the funding workbook covers, when one is uploaded. */
  fundingMonth?: string | null;
  onOverrides?: (o: Record<string, string>) => void;
}

const FIELDS: { key: string; label: string; width?: number }[] = [
  { key: "address1", label: "Address" },
  { key: "city", label: "City" },
  { key: "state", label: "State", width: 90 },
  { key: "zip", label: "ZIP", width: 130 },
  { key: "sic", label: "SIC code", width: 130 },
  { key: "sicDesc", label: "SIC description" },
  { key: "taxId", label: "EIN", width: 180 },
  { key: "phone", label: "Phone", width: 180 },
  { key: "corporationType", label: "Corporation type", width: 180 },
  { key: "situsState", label: "Situs state", width: 90 },
];

/**
 * The group's own sign-in link. Opening it is exactly what the client sees, so
 * staff can check a company's pages without knowing its code by heart — and it
 * is the link to send the client. The code is the credential, so the link is
 * too: anyone holding it is signed in as that group.
 */
function ClientLink({
  code,
  token,
  archived,
  onReset,
}: {
  code: string;
  token: string | null;
  archived: boolean;
  onReset: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = token ? `${origin}/g/${token}` : `${origin}/?code=${encodeURIComponent(code)}`;
  return (
    <div style={{ marginTop: 14 }}>
      <label style={{ display: "block", fontSize: 12.5, color: C.body, marginBottom: 5 }}>
        Client sign-in link
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 12.5,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            color: C.blue,
            wordBreak: "break-all",
          }}
        >
          {url.replace(/^https?:\/\//, "")}
        </a>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => undefined,
            );
          }}
          style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: copied ? C.green : C.blue, cursor: "pointer" }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div style={{ marginTop: 5, fontSize: 11.5, color: C.faint, lineHeight: 1.5, maxWidth: 460 }}>
        {archived ? (
          "This group is archived, so the link is refused until it is restored."
        ) : (
          <>
            The group&rsquo;s permanent address: bookmark it, send it, come back to it — no code to type, and it
            stays in the bar. Anyone holding it sees this company&rsquo;s pages, so send it to the client rather
            than posting it anywhere public.{" "}
            {confirmReset ? (
              <>
                <button
                  onClick={async () => {
                    setConfirmReset(false);
                    await onReset();
                  }}
                  style={{ background: "none", border: "none", padding: 0, fontSize: 11.5, color: C.red, fontWeight: 600, cursor: "pointer" }}
                >
                  Replace it — the old link stops working
                </button>
                {" · "}
                <button onClick={() => setConfirmReset(false)} style={{ background: "none", border: "none", padding: 0, fontSize: 11.5, color: C.blue, cursor: "pointer" }}>
                  Keep
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmReset(true)} style={{ background: "none", border: "none", padding: 0, fontSize: 11.5, color: C.blue, cursor: "pointer" }}>
                New link
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function GroupDetail({ group, token, onChanged, onBack, onOpenRates, fundingMonth, onOverrides }: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);

  const edited = new Set(group.editedFields || []);

  async function save(field: string, value: unknown) {
    setError("");
    const r = await fetch("/api/admin/group-meta", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ group: group.name, field, value }),
    });
    const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
    if (!r.ok) {
      setError(j.error || "Could not save.");
      return false;
    }
    onChanged(j.groups);
    setSaved(field);
    setTimeout(() => setSaved(""), 1500);
    return true;
  }

  const val = (k: string) =>
    draft[k] ?? ((group as unknown as Record<string, string | null>)[k] || "");

  const input = (k: string, width?: number) => (
    <input
      value={val(k)}
      onChange={(e) => setDraft((p) => ({ ...p, [k]: e.target.value }))}
      onBlur={async () => {
        const current = (group as unknown as Record<string, string | null>)[k] || "";
        if (draft[k] == null || draft[k] === current) return;
        await save(k, draft[k]);
        setDraft((p) => {
          const n = { ...p };
          delete n[k];
          return n;
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      aria-label={k}
      style={{
        width: width ? width : "100%",
        maxWidth: "100%",
        padding: "7px 9px",
        fontSize: 13,
        color: C.ink,
        border: `1px solid ${saved === k ? C.greenEdge : C.inputEdge}`,
        background: saved === k ? C.greenTint : "#fff",
        borderRadius: 4,
        outline: "none",
      }}
    />
  );

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, margin: "4px 0 14px" }}>
        <nav aria-label="Breadcrumb" style={{ fontSize: 13, color: C.faint }}>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", gap: 6 }}>
            <li>
              <Link href={PATHS.groups}>Groups</Link>
            </li>
            <li aria-hidden="true">›</li>
            <li aria-current="page" style={{ color: C.ink }}>
              {group.name}
            </li>
          </ol>
        </nav>
        {group.archived && (
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: C.amber,
              background: C.amberTint,
              border: `1px solid ${C.amberEdge}`,
              borderRadius: 3,
              padding: "3px 8px",
            }}
          >
            Archived — cannot sign in{group.notInExport ? " · not in the Employee Navigator export" : ""}
          </span>
        )}
      </div>

      <div style={{ ...panel, padding: "20px 22px" }}>
        <h2 style={{ margin: 0, fontSize: 21, fontWeight: 600, color: C.ink, letterSpacing: "-0.2px" }}>
          {group.name}
        </h2>
        <div style={{ marginTop: 6, fontSize: 13, color: C.muted }}>
          {group.tpa || "—"} · {group.enrolled} enrolled · {group.lives} covered lives
          {group.pyStart && ` · plan year ${group.pyStart} to ${group.pyEnd}`}
        </div>

        {error && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: "9px 12px",
              background: C.redTint,
              border: `1px solid ${C.redEdge}`,
              borderRadius: 4,
              fontSize: 13,
              color: C.red,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 18, marginTop: 18 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: ".4px" }}>
              Access
            </div>
            <div style={{ marginTop: 10 }}>
              <label style={{ display: "block", fontSize: 12.5, color: C.body, marginBottom: 5 }}>
                Company ID — the code this group signs in with
              </label>
              <input
                value={draft.companyId ?? group.code}
                onChange={(e) => setDraft((p) => ({ ...p, companyId: e.target.value.toUpperCase() }))}
                onBlur={async () => {
                  if (draft.companyId == null || draft.companyId === group.code) return;
                  const ok = await save("companyId", draft.companyId);
                  if (ok) setDraft((p) => { const n = { ...p }; delete n.companyId; return n; });
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                aria-label="Company ID"
                style={{
                  width: 180,
                  padding: "7px 9px",
                  fontSize: 13,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontWeight: 600,
                  color: C.ink,
                  border: `1px solid ${saved === "companyId" ? C.greenEdge : C.inputEdge}`,
                  background: saved === "companyId" ? C.greenTint : "#fff",
                  borderRadius: 4,
                  outline: "none",
                }}
              />
            </div>

            <ClientLink
              code={group.code}
              token={group.linkToken || null}
              archived={!!group.archived}
              onReset={async () => {
                const r = await fetch("/api/admin/group-link/reset", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ group: group.name }),
                });
                const j = await r.json().catch(() => ({}));
                if (r.ok && j.groups) onChanged(j.groups);
              }}
            />

            <div style={{ marginTop: 14 }}>
              <label style={{ display: "block", fontSize: 12.5, color: C.body, marginBottom: 5 }}>
                Size
              </label>
              <div style={{ display: "flex", gap: 4 }}>
                {(["2-50", "51+"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => void save("sizeCategory", s)}
                    style={{
                      padding: "7px 14px",
                      fontSize: 13,
                      borderRadius: 4,
                      cursor: "pointer",
                      ...(group.sizeCategory === s
                        ? { color: "#fff", background: C.blue, border: `1px solid ${C.blue}`, fontWeight: 500 }
                        : { color: C.body, background: "#fff", border: `1px solid ${C.inputEdge}` }),
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {!group.sizeIsSet && (
                <div style={{ fontSize: 11.5, color: C.ghost, marginTop: 4 }}>
                  defaulted from headcount — set it to make the ALE call explicit
                </div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={{ display: "block", fontSize: 12.5, color: C.body, marginBottom: 5 }}>
                Broker
              </label>
              <div style={{ display: "flex", gap: 4 }} role="group" aria-label="Broker">
                {(["kennion", "outside"] as const).map((b) => {
                  const on = (group.broker || "kennion") === b;
                  return (
                    <button
                      key={b}
                      onClick={() => void save("broker", b)}
                      aria-pressed={on}
                      style={{
                        padding: "7px 14px",
                        fontSize: 13,
                        borderRadius: 4,
                        cursor: "pointer",
                        ...(on
                          ? {
                              color: "#fff",
                              background: b === "outside" ? C.amber : C.blue,
                              border: `1px solid ${b === "outside" ? C.amber : C.blue}`,
                              fontWeight: 500,
                            }
                          : { color: C.body, background: "#fff", border: `1px solid ${C.inputEdge}` }),
                      }}
                    >
                      {BROKER_LABEL[b]}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, color: C.ghost, marginTop: 4 }}>
                Whether Kennion places this group directly or an outside broker does. Only the label
                is kept, not a name.
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={{ display: "block", fontSize: 12.5, color: C.body, marginBottom: 5 }}>
                2027 renewal
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }} role="group" aria-label="Renewal">
                {RENEWALS.map((r) => {
                  const on = (group.renewal || "open") === r;
                  const [fg, bg, bd] = RENEWAL_TONE[r];
                  return (
                    <button
                      key={r}
                      onClick={() => void save("renewal", r)}
                      aria-pressed={on}
                      style={{
                        padding: "7px 14px",
                        fontSize: 13,
                        borderRadius: 4,
                        cursor: "pointer",
                        ...(on
                          ? { color: "#fff", background: fg, border: `1px solid ${fg}`, fontWeight: 500 }
                          : { color: fg, background: bg, border: `1px solid ${bd}` }),
                      }}
                    >
                      {RENEWAL_LABEL[r]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ marginTop: 14, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
              Data from{" "}
              {group.importedAt ? (
                <strong style={{ color: C.green }}>
                  XML import, {new Date(group.importedAt).toLocaleString()}
                </strong>
              ) : (
                <strong style={{ color: C.body }}>the shipped census (7/31/2026)</strong>
              )}
            </div>
          </div>

          <div style={{ gridColumn: "span 2", minWidth: 280 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.faint, textTransform: "uppercase", letterSpacing: ".4px" }}>
              Company
            </div>
            <div
              style={{
                marginTop: 10,
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                gap: 12,
              }}
            >
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <label style={{ display: "block", fontSize: 12.5, color: C.body, marginBottom: 5 }}>
                    {f.label}
                    {edited.has(f.key) && (
                      <span style={{ color: C.blue, fontSize: 11 }}> · edited</span>
                    )}
                  </label>
                  {input(f.key, f.width)}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: C.ghost, lineHeight: 1.6 }}>
              Edits here override what the export supplied and survive the next import. The company
              name is not editable — it is what an import matches on, so changing it would orphan
              the group.
            </div>
          </div>
        </div>
      </div>

      {!!group.contacts?.length && (
        <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>Contacts</h3>
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {group.contacts.map((c, i) => (
              <div key={i} style={{ fontSize: 13, color: C.body }}>
                <strong style={{ color: C.ink }}>{c.name}</strong>
                {c.email && (
                  <>
                    {" · "}
                    <a href={`mailto:${c.email}`}>{c.email}</a>
                  </>
                )}
                {c.phone && ` · ${c.phone}`}
              </div>
            ))}
          </div>
        </div>
      )}

      {!!group.plans?.length && (
        <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>Plans In Force</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
            <thead>
              <tr>
                {["Plan", "TPA", "Enrolled", "Monthly premium"].map((h, i) => (
                  <th
                    key={h}
                    style={{
                      textAlign: i >= 2 ? "right" : "left",
                      padding: "9px 8px 9px 0",
                      fontWeight: 600,
                      color: C.ink,
                      borderBottom: `1px solid ${C.border}`,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.plans.map((p) => (
                <tr key={p.plan}>
                  <td style={{ padding: "9px 8px 9px 0", borderBottom: `1px solid ${C.hairline}`, color: C.ink }}>
                    {p.plan}
                  </td>
                  <td style={{ padding: 9, borderBottom: `1px solid ${C.hairline}`, color: C.body }}>{p.tpa}</td>
                  <td style={{ padding: 9, borderBottom: `1px solid ${C.hairline}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {p.enrolled}
                  </td>
                  <td style={{ padding: "9px 0 9px 9px", borderBottom: `1px solid ${C.hairline}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {money0(p.monthly)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, fontSize: 12.5, color: C.faint }}>
            Tier rates for these plans are on{" "}
            <Link href={PATHS.rates} onClick={() => onOpenRates(group.name)}>
              Existing Plans &amp; Rates
            </Link>
            .
          </div>
        </div>
      )}

      {/* Everything that is not medical — dental, vision, life, disability —
          as premium totals only; the portal never prices these. */}
      {!!group.plans?.length && (
        <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>Other Lines In Force</h3>
          {group.lines?.length ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 10 }}>
              <thead>
                <tr>
                  {["Benefit", "Carrier", "Plan", "Enrolled", "Monthly premium"].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i >= 3 ? "right" : "left",
                        padding: i === 0 ? "9px 8px 9px 0" : 9,
                        fontWeight: 600,
                        color: C.ink,
                        borderBottom: `1px solid ${C.border}`,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {group.lines.map((l) => (
                  <tr key={`${l.benefit}|${l.carrier}|${l.plan}`}>
                    <td style={{ padding: "9px 8px 9px 0", borderBottom: `1px solid ${C.hairline}`, color: C.ink }}>
                      {l.benefit}
                    </td>
                    <td style={{ padding: 9, borderBottom: `1px solid ${C.hairline}`, color: C.body }}>{l.carrier || "—"}</td>
                    <td style={{ padding: 9, borderBottom: `1px solid ${C.hairline}`, color: C.body }}>{l.plan}</td>
                    <td style={{ padding: 9, borderBottom: `1px solid ${C.hairline}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {l.enrolled}
                    </td>
                    <td style={{ padding: "9px 0 9px 9px", borderBottom: `1px solid ${C.hairline}`, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {money0(l.monthly)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : group.linesLoaded ? (
            <div style={{ marginTop: 8, fontSize: 13, color: C.muted }}>
              No dental, vision, life or disability enrollment in this group's export.
            </div>
          ) : (
            <div style={{ marginTop: 8, fontSize: 13, color: C.muted }}>
              Supplemental lines will appear here after the next Employee Navigator import.
            </div>
          )}
          <div style={{ marginTop: 10, fontSize: 12.5, color: C.faint, fontVariantNumeric: "tabular-nums" }}>
            Monthly premium: <strong style={{ color: C.body, fontWeight: 500 }}>{money0(group.groupHealthMonthly ?? 0)}</strong>{" "}
            group health (EBPA + HealthEZ) · {money0(group.medicalMonthly ?? 0)} medical ·{" "}
            {money0(group.supplementalMonthly ?? 0)} supplemental · {money0(group.totalMonthly ?? 0)} total
          </div>
        </div>
      )}

      <GroupBilling token={token} group={group} month={fundingMonth || null} onOverrides={onOverrides || (() => undefined)} />

      <GroupProposals group={group.name} token={token} />

      <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: C.ink }}>
          {group.archived ? "Restore" : "Archive"}
        </h3>
        <div style={{ marginTop: 8, fontSize: 12.5, color: C.muted, lineHeight: 1.6, maxWidth: 720 }}>
          {group.archived
            ? `This group is archived${group.notInExport ? ` because the Employee Navigator export of ${new Date(group.notInExport).toLocaleDateString()} no longer carried it` : ""}: hidden from the list by default, and its access code is refused at sign-in. Nothing was deleted — restoring puts it straight back, and later imports leave that alone.`
            : "Archiving hides the group from the list and refuses its access code at sign-in. Nothing is deleted, and it can be restored at any time."}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
          {group.archived ? (
            <button
              onClick={() => void save("archived", false)}
              style={{
                padding: "8px 16px",
                fontSize: 13.5,
                fontWeight: 500,
                color: "#fff",
                background: C.blue,
                border: `1px solid ${C.blue}`,
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Restore group
            </button>
          ) : confirmArchive ? (
            <>
              <button
                onClick={async () => {
                  if (await save("archived", true)) onBack();
                }}
                style={{
                  padding: "8px 16px",
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: "#fff",
                  background: C.red,
                  border: `1px solid ${C.red}`,
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Yes, archive {group.name}
              </button>
              <button
                onClick={() => setConfirmArchive(false)}
                style={{ background: "none", border: "none", fontSize: 13, color: C.blue, cursor: "pointer" }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmArchive(true)}
              style={{
                padding: "8px 16px",
                fontSize: 13.5,
                color: C.red,
                background: "#fff",
                border: `1px solid ${C.redEdge}`,
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Archive group
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
