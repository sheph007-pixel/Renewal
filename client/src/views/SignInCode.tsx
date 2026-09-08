import { useEffect, useState } from "react";
import { C, panel } from "@/lib/importui";

/**
 * Change the staff sign-in code without leaving the app. The code lives in
 * the database, not in the host's settings, so this is the whole of it —
 * there is nothing to configure anywhere else.
 */
export default function SignInCode({ token }: { token: string }) {
  const [where, setWhere] = useState<{ source: string; changeable: boolean } | null>(null);
  const [twoFactorOn, setTwoFactorOn] = useState(false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  useEffect(() => {
    let live = true;
    void fetch("/api/admin/code", { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && j && setWhere(j))
      .catch(() => {});
    // Whether to ask for the second factor as well when changing the code.
    void fetch("/api/admin/2fa", { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => live && j && setTwoFactorOn(!!j.on))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const save = async () => {
    setError("");
    if (next !== again) return setError("The two new codes do not match.");
    if (next.length < 10) return setError("Use at least ten characters.");
    setBusy(true);
    try {
      const r = await fetch("/api/admin/code", {
        method: "POST",
        headers,
        body: JSON.stringify({ current, next, totp }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not change the code.");
      setDone(true);
      setOpen(false);
      setCurrent("");
      setNext("");
      setAgain("");
      setTotp("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const link = { background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" };
  const field: React.CSSProperties = {
    width: 260,
    padding: "7px 9px",
    fontSize: 13,
    border: `1px solid ${C.hairline}`,
    borderRadius: 4,
  };
  const row = { display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: 10, marginTop: 10 };

  return (
    <section style={{ ...panel, marginTop: 16, padding: "18px 22px" }} aria-label="Sign-in code">
      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Sign-In Code</h2>

      <p style={{ margin: "8px 0 0", fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 720 }}>
        {where?.source === "env"
          ? "The code is set in the host's settings, so it can only be changed there."
          : where?.source === "memory"
            ? "There is no database on this run, so the code lasts only until the server restarts."
            : "The code is kept here, hashed, and survives every restart. Change it whenever you like — nothing needs setting anywhere else."}
      </p>

      {done && (
        <div style={{ marginTop: 10, fontSize: 13, color: C.green }}>
          Changed. The new code works from the next sign-in.
        </div>
      )}

      {where?.changeable && !open && (
        <button onClick={() => { setOpen(true); setDone(false); }} style={{ ...link, marginTop: 10 }}>
          Change the code
        </button>
      )}

      {open && (
        <div style={{ marginTop: 4 }}>
          <div style={row}>
            <label style={{ fontSize: 13, color: C.body, width: 150 }}>Code in use now</label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              style={field}
            />
          </div>
          <div style={row}>
            <label style={{ fontSize: 13, color: C.body, width: 150 }}>New code</label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              placeholder="at least ten characters"
              style={field}
            />
          </div>
          <div style={row}>
            <label style={{ fontSize: 13, color: C.body, width: 150 }}>New code again</label>
            <input
              type="password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              autoComplete="new-password"
              style={field}
            />
          </div>
          {twoFactorOn && (
            <div style={row}>
              <label style={{ fontSize: 13, color: C.body, width: 150 }}>From your app</label>
              <input
                inputMode="numeric"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="six digits"
                style={{ ...field, width: 120, letterSpacing: 2 }}
              />
            </div>
          )}
          <div style={{ ...row, gap: 14 }}>
            <button
              onClick={() => void save()}
              disabled={busy}
              style={{
                padding: "7px 16px",
                fontSize: 13,
                fontWeight: 600,
                color: "#fff",
                background: C.blue,
                border: "none",
                borderRadius: 4,
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Saving…" : "Save the new code"}
            </button>
            <button onClick={() => { setOpen(false); setError(""); }} style={link}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 10, fontSize: 13, color: C.red }}>
          {error}
        </div>
      )}
    </section>
  );
}
