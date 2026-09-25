import { useEffect, useMemo, useState } from "react";
import { C, chip, h2, h3, panel, primaryBtn, textInput, th, td } from "@/lib/ui";
import Link from "@/lib/Link";
import { groupPath } from "@/lib/router";
import { effectiveDateLabel, type WelcomeCopy } from "@/lib/model";
import type { AdminGroup } from "@/views/GroupsTable";

type Status = "existing" | "new";

interface CopyResponse {
  copy: Record<Status, WelcomeCopy>;
  defaults: Record<Status, WelcomeCopy>;
  savedAt: string | null;
  savedBy: string | null;
}

const STATUS_LABEL: Record<Status, string> = { existing: "Existing Groups", new: "New Groups" };

const label = { display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, margin: "14px 0 5px" } as const;
const hint = { fontSize: 11.5, color: C.ghost, marginTop: 4, lineHeight: 1.5 } as const;
const field = { ...textInput, width: "100%", boxSizing: "border-box" as const, fontSize: 13.5, fontFamily: "inherit", lineHeight: 1.6 };
const area = { ...field, resize: "vertical" as const };

const same = (a: WelcomeCopy | undefined, b: WelcomeCopy | undefined) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The Welcome page's words, written once for every group: one set for
 * Existing groups and one for New, with the same fields on each - headline,
 * intro, the four How It Works steps, the closing section, the team card's
 * note and the page footer. Saving pushes it to every group of that status on
 * its next page load. What stays dynamic (each group's name and date, its
 * team, where the steps link) is not here, except the two copy-only
 * overrides at the bottom: the name and effective date a group is shown,
 * which never touch the official record.
 */
export default function AdminWelcome({
  token,
  groups,
  onChanged,
}: {
  token: string;
  groups: AdminGroup[];
  onChanged: (groups: AdminGroup[]) => void;
}) {
  const [status, setStatus] = useState<Status>("existing");
  const [server, setServer] = useState<CopyResponse | null>(null);
  const [draft, setDraft] = useState<Partial<Record<Status, WelcomeCopy>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/admin/welcome-copy", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Server returned ${r.status}.`);
        setServer(j as CopyResponse);
      })
      .catch((e) => setError((e as Error).message || "Could not load the Welcome page copy."));
  }, [token]);

  const counts = useMemo(() => {
    const n = { existing: 0, new: 0 };
    for (const g of groups) n[g.groupStatus === "new" ? "new" : "existing"]++;
    return n;
  }, [groups]);

  if (!server) {
    return (
      <div style={{ ...panel, padding: "20px 22px", fontSize: 13, color: error ? C.red : C.muted }}>
        {error || "Loading the Welcome page copy…"}
      </div>
    );
  }

  const saved = server.copy[status];
  const copy = draft[status] ?? saved;
  const dirty = !!draft[status] && !same(draft[status], saved);
  const isDefault = same(saved, server.defaults[status]);
  const set = (patch: Partial<WelcomeCopy>) => setDraft((d) => ({ ...d, [status]: { ...copy, ...patch } }));
  const setStep = (i: number, patch: Partial<WelcomeCopy["steps"][number]>) =>
    set({ steps: copy.steps.map((st, k) => (k === i ? { ...st, ...patch } : st)) });

  async function post(body: object, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch("/api/admin/welcome-copy", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
      if (!r.ok) throw new Error(j.error || "Could not save.");
      setServer(j as CopyResponse);
      setDraft((d) => {
        const n = { ...d };
        delete n[status];
        return n;
      });
      setNotice(done);
      setTimeout(() => setNotice(""), 4000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = () => post({ status, copy }, `Saved. Every ${status === "new" ? "New" : "Existing"} group sees it on its next page load.`);
  const reset = () => {
    if (!confirm(`Put the ${STATUS_LABEL[status]} copy back to the defaults? What is saved now is replaced.`)) return;
    void post({ status, reset: true }, "Back to the defaults.");
  };

  return (
    <div>
      <div style={{ ...panel, padding: "20px 22px" }}>
        <h2 style={h2}>Welcome Page</h2>
        <div style={{ marginTop: 6, fontSize: 13, color: C.muted, lineHeight: 1.6, maxWidth: 780 }}>
          The words on every group&rsquo;s Welcome page, written once. Existing and New groups each have their own
          copy, with the same fields. Save, and every group of that status sees it on its next page load. Each
          group&rsquo;s name, effective date, team and links stay its own. Leave a field blank to hide it, and leave a
          blank line between paragraphs to start a new one.
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 16 }} role="tablist" aria-label="Group status">
          {(["existing", "new"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)} style={chip(status === s)}>
              {STATUS_LABEL[s]} ({counts[s]}){draft[s] && !same(draft[s], server.copy[s]) ? " •" : ""}
            </button>
          ))}
        </div>

        <div style={{ marginTop: 6 }}>
          <label style={label} htmlFor="w-headline">Headline</label>
          <input id="w-headline" value={copy.headline} onChange={(e) => set({ headline: e.target.value })} placeholder="(none)" style={{ ...field, fontWeight: 600 }} />
          <div style={hint}>Shown in bold under the group&rsquo;s name and effective date.</div>

          <label style={label} htmlFor="w-intro">Intro</label>
          <textarea id="w-intro" rows={5} value={copy.intro} onChange={(e) => set({ intro: e.target.value })} placeholder="(none)" style={area} />

          <div style={{ ...label, marginTop: 20 }}>How It Works</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
            {copy.steps.map((st, i) => (
              <div key={i} style={{ padding: "10px 10px 12px", borderRadius: 8, background: C.zebra, border: `1px solid ${C.hairline}` }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.5px", color: C.blueInk, textTransform: "uppercase", marginBottom: 6 }}>Step {i + 1}</div>
                <textarea
                  aria-label={`Step ${i + 1} title`}
                  rows={2}
                  value={st.title}
                  onChange={(e) => setStep(i, { title: e.target.value })}
                  style={{ ...area, fontWeight: 600, color: C.blue, fontSize: 13.5 }}
                />
                <textarea
                  aria-label={`Step ${i + 1} description`}
                  rows={4}
                  value={st.body}
                  onChange={(e) => setStep(i, { body: e.target.value })}
                  style={{ ...area, marginTop: 6, fontSize: 12.5 }}
                />
              </div>
            ))}
          </div>
          <div style={hint}>
            A line break in a title is where it wraps on the page. Where each step links is fixed. &ldquo;AI Assistant&rdquo;
            in a description links to the assistant, and step 4 adds when the group last submitted.
          </div>

          <label style={{ ...label, marginTop: 20 }} htmlFor="w-closing-heading">Closing heading</label>
          <input id="w-closing-heading" value={copy.closingHeading} onChange={(e) => set({ closingHeading: e.target.value })} placeholder="(none)" style={{ ...field, fontWeight: 600 }} />
          <label style={label} htmlFor="w-closing-body">Closing text</label>
          <textarea id="w-closing-body" rows={5} value={copy.closingBody} onChange={(e) => set({ closingBody: e.target.value })} placeholder="(none)" style={area} />
          <label style={label} htmlFor="w-closing-tagline">Closing line</label>
          <input id="w-closing-tagline" value={copy.closingTagline} onChange={(e) => set({ closingTagline: e.target.value })} placeholder="(none)" style={field} />
          <div style={hint}>The bold last line under How It Works.</div>

          <label style={{ ...label, marginTop: 20 }} htmlFor="w-team-note">Team card note</label>
          <input id="w-team-note" value={copy.teamNote} onChange={(e) => set({ teamNote: e.target.value })} placeholder="(none)" style={field} />
          <div style={hint}>The line at the foot of the Your Kennion Team card.</div>

          <label style={{ ...label, marginTop: 20 }} htmlFor="w-footer">Footer</label>
          <textarea id="w-footer" rows={3} value={copy.footer} onChange={(e) => set({ footer: e.target.value })} placeholder="(the standard rate notice)" style={area} />
          <div style={hint}>The notice at the bottom of every page the group sees, printed reports included. The View Disclaimers link follows it.</div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.rule}` }}>
          <button onClick={() => void save()} disabled={busy || !dirty} style={{ ...primaryBtn, opacity: busy || !dirty ? 0.55 : 1, cursor: busy || !dirty ? "default" : "pointer" }}>
            {busy ? "Saving…" : `Save for ${STATUS_LABEL[status]}`}
          </button>
          {dirty && (
            <button
              onClick={() => setDraft((d) => { const n = { ...d }; delete n[status]; return n; })}
              style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" }}
            >
              Discard changes
            </button>
          )}
          {!isDefault && !dirty && (
            <button onClick={reset} disabled={busy} style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" }}>
              Reset to defaults
            </button>
          )}
          {notice && <span style={{ fontSize: 13, color: C.green }}>{notice}</span>}
          {error && <span role="alert" style={{ fontSize: 13, color: C.red }}>{error}</span>}
          {!notice && !error && server.savedAt && (
            <span style={{ fontSize: 12, color: C.ghost }}>
              Last saved {new Date(server.savedAt).toLocaleString()}
              {server.savedBy ? ` by ${server.savedBy}` : ""}
            </span>
          )}
        </div>
      </div>

      <ShownNames
        token={token}
        groups={groups.filter((g) => (g.groupStatus === "new" ? "new" : "existing") === status)}
        status={status}
        onChanged={onChanged}
      />
    </div>
  );
}

/**
 * The name and effective date each group is shown on its own pages, when the
 * official ones read badly ("Johnson Storage & Moving" for the full legal
 * name). Copy only: the name an import matches on, and the date Sign Up and
 * the PDFs work from, stay as they are. Blank shows the official value.
 */
function ShownNames({
  token,
  groups,
  status,
  onChanged,
}: {
  token: string;
  groups: AdminGroup[];
  status: Status;
  onChanged: (groups: AdminGroup[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  const shown = groups
    .filter((g) => !query.trim() || `${g.name} ${g.displayName || ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  async function save(group: string, field: "displayName" | "effectiveDateLabel", value: string, key: string) {
    setError("");
    const r = await fetch("/api/admin/group-meta", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ group, field, value: value.trim() || null }),
    });
    const j = await r.json().catch(() => ({ error: `Server returned ${r.status}.` }));
    if (!r.ok) {
      setError(j.error || "Could not save.");
      return;
    }
    onChanged(j.groups);
    setDraft((d) => {
      const n = { ...d };
      delete n[key];
      return n;
    });
    setSaved(key);
    setTimeout(() => setSaved(""), 1500);
  }

  const cell = (g: AdminGroup, fieldName: "displayName" | "effectiveDateLabel", placeholder: string) => {
    const key = `${g.name}|${fieldName}`;
    const current = g[fieldName] || "";
    return (
      <input
        value={draft[key] ?? current}
        placeholder={placeholder}
        aria-label={`${fieldName === "displayName" ? "Name shown" : "Effective date shown"} for ${g.name}`}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={() => {
          const v = draft[key];
          if (v == null || v.trim() === current) return;
          void save(g.name, fieldName, v, key);
        }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        style={{
          ...textInput,
          width: "100%",
          boxSizing: "border-box",
          padding: "6px 9px",
          fontSize: 13,
          border: `1px solid ${saved === key ? C.greenEdge : C.inputEdge}`,
          background: saved === key ? C.greenTint : "#fff",
        }}
      />
    );
  };

  return (
    <div style={{ ...panel, marginTop: 16, padding: "18px 22px" }}>
      <h3 style={h3}>Name &amp; Effective Date Shown</h3>
      <div style={{ marginTop: 4, fontSize: 12.5, color: C.muted, lineHeight: 1.6, maxWidth: 780 }}>
        How each {status === "new" ? "New" : "Existing"} group&rsquo;s name and effective date read on its own pages. This is copy
        only: the official company name, which imports match on, and the effective date Sign Up and the PDFs use
        don&rsquo;t change. Leave a field blank to show the official value. Saves when you leave the field.
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search groups"
        aria-label="Search groups"
        style={{ ...textInput, marginTop: 12, width: 280, maxWidth: "100%", padding: "7px 10px", fontSize: 13 }}
      />
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: C.red }}>{error}</div>}
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left", width: "30%" }}>Official name</th>
              <th style={{ ...th, textAlign: "left", width: "32%" }}>Name shown</th>
              <th style={{ ...th, textAlign: "left", width: "14%" }}>Official date</th>
              <th style={{ ...th, textAlign: "left" }}>Effective date shown</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => {
              const official = effectiveDateLabel({ effectiveDate: g.effectiveDate || undefined });
              return (
                <tr key={g.name}>
                  <td style={{ ...td, color: C.ink }}>
                    <Link href={groupPath(g.name)}>{g.name}</Link>
                  </td>
                  <td style={td}>{cell(g, "displayName", g.name)}</td>
                  <td style={{ ...td, color: C.muted, whiteSpace: "nowrap" }}>{official}</td>
                  <td style={td}>{cell(g, "effectiveDateLabel", official)}</td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={4} style={{ ...td, color: C.faint }}>
                  {query ? "No group matches." : `No ${STATUS_LABEL[status]} yet.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
