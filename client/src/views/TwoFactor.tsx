import { useEffect, useState } from "react";
import { C, panel } from "@/lib/importui";

/**
 * Two-factor setup for a staff session. The secret is shown as text to type
 * into an authenticator app and as the otpauth URL behind a link, so no QR
 * library and no third-party image service is needed — nothing about the
 * secret leaves this page.
 */
export default function TwoFactor({ token }: { token: string }) {
  const [state, setState] = useState<{ on: boolean; started: boolean; recoveryLeft: number } | null>(null);
  const [secret, setSecret] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const load = async () => {
    const r = await fetch("/api/admin/2fa", { headers });
    if (r.ok) setState(await r.json());
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/2fa/start", { method: "POST", headers });
      if (!r.ok) throw new Error("Could not start setup.");
      setSecret(await r.json());
      setRecovery(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/admin/2fa/confirm", { method: "POST", headers, body: JSON.stringify({ code }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "That code is not right.");
      setRecovery(j.recovery);
      setSecret(null);
      setCode("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await fetch("/api/admin/2fa/off", { method: "POST", headers });
      setSecret(null);
      setRecovery(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const link = { background: "none", border: "none", padding: 0, fontSize: 13, color: C.blue, cursor: "pointer" };
  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

  return (
    <section style={{ ...panel, marginTop: 16, padding: "18px 22px" }} aria-label="Two-factor sign-in">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: C.ink }}>Two-Factor Sign-In</h2>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "3px 9px",
            borderRadius: 3,
            color: state?.on ? C.green : C.amber,
            background: state?.on ? C.greenTint : C.amberTint,
            border: `1px solid ${state?.on ? C.greenEdge : C.amberEdge}`,
          }}
        >
          {state?.on ? "On" : "Off"}
        </span>
        {state?.on && (
          <span style={{ fontSize: 12.5, color: C.faint }}>{state.recoveryLeft} recovery codes left</span>
        )}
      </div>

      {!state?.on && !secret && !recovery && (
        <div style={{ marginTop: 10, fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 720 }}>
          With this on, the sign-in code alone will not open the portal — it also asks for six digits from an
          authenticator app on your phone. Anyone who learns the code still gets nowhere.{" "}
          <button onClick={() => void start()} disabled={busy} style={{ ...link, fontWeight: 600 }}>
            Set it up
          </button>
        </div>
      )}

      {secret && (
        <div style={{ marginTop: 12, fontSize: 13, color: C.body, lineHeight: 1.65, maxWidth: 720 }}>
          <p style={{ margin: "0 0 8px" }}>
            In Google Authenticator, 1Password, Authy or whatever you use, add an account and type this key:
          </p>
          <div
            style={{
              ...mono,
              fontSize: 15,
              letterSpacing: "1px",
              padding: "10px 12px",
              background: C.zebra,
              border: `1px solid ${C.hairline}`,
              borderRadius: 4,
              wordBreak: "break-all",
            }}
          >
            {secret.secret}
          </div>
          <p style={{ margin: "8px 0" }}>
            On a phone you can{" "}
            <a href={secret.otpauth} style={{ color: C.blue }}>
              open it straight into the app
            </a>{" "}
            instead. Then type the six digits it shows:
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirm();
              }}
              inputMode="numeric"
              placeholder="123456"
              aria-label="Code from your authenticator app"
              style={{ ...mono, width: 130, padding: "8px 10px", fontSize: 15, letterSpacing: "2px", border: `1px solid ${C.inputEdge}`, borderRadius: 4 }}
            />
            <button
              onClick={() => void confirm()}
              disabled={busy || code.trim().length < 6}
              style={{
                padding: "8px 14px",
                fontSize: 13,
                fontWeight: 500,
                color: "#fff",
                background: C.blue,
                border: `1px solid ${C.blue}`,
                borderRadius: 4,
                cursor: busy ? "default" : "pointer",
                opacity: busy || code.trim().length < 6 ? 0.6 : 1,
              }}
            >
              Turn it on
            </button>
            <button onClick={() => setSecret(null)} style={link}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {recovery && (
        <div style={{ marginTop: 12, fontSize: 13, color: C.body, lineHeight: 1.65, maxWidth: 720 }}>
          <p style={{ margin: "0 0 8px", color: C.green, fontWeight: 600 }}>Two-factor is on.</p>
          <p style={{ margin: "0 0 8px" }}>
            Keep these recovery codes somewhere safe — each one signs you in once if you lose your phone. This
            is the only time they are shown.
          </p>
          <div
            style={{
              ...mono,
              fontSize: 13.5,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
              gap: 6,
              padding: "10px 12px",
              background: C.zebra,
              border: `1px solid ${C.hairline}`,
              borderRadius: 4,
            }}
          >
            {recovery.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <button
            onClick={() => void navigator.clipboard?.writeText(recovery.join("\n"))}
            style={{ ...link, marginTop: 8 }}
          >
            Copy them
          </button>
        </div>
      )}

      {state?.on && !recovery && (
        <div style={{ marginTop: 10, fontSize: 13, color: C.body, lineHeight: 1.6, maxWidth: 720 }}>
          Sign-in asks for six digits from your authenticator app.{" "}
          <button onClick={() => void start()} disabled={busy} style={link}>
            Set up a new phone
          </button>
          {" · "}
          <button onClick={() => void turnOff()} disabled={busy} style={{ ...link, color: C.red }}>
            Turn it off
          </button>
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
