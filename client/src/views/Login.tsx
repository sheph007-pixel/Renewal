import { BenSync, C, Logo, panel, primaryBtn, textInput } from "@/lib/ui";

interface Props {
  mode: "group" | "staff";
  codeInput: string;
  email: string;
  staffCode: string;
  codeError: boolean;
  staffError: boolean;
  busy: boolean;
  onCode: (v: string) => void;
  onEmail: (v: string) => void;
  onStaffCode: (v: string) => void;
  onSubmit: () => void;
  onStaffSubmit: () => void;
  onMode: (m: "group" | "staff") => void;
  /** Set once the code is accepted and the second factor is owed. */
  twoFactor: boolean;
  totpCode: string;
  onTotpCode: (v: string) => void;
  onTotpSubmit: () => void;
  onCancelTwoFactor: () => void;
}

const labelStyle = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: C.ink,
  marginBottom: 7,
} as const;

const fieldGap = { marginBottom: 16 } as const;

const card = {
  ...panel,
  borderRadius: 14,
  boxShadow: "0 10px 30px -18px rgba(15,42,71,0.20), 0 1px 3px rgba(15,42,71,0.05)",
  padding: "34px 32px 30px",
} as const;

const fullInput = { ...textInput, width: "100%", padding: "11px 13px", borderRadius: 8 } as const;

const fullBtn = {
  ...primaryBtn,
  width: "100%",
  padding: "12px 20px",
  borderRadius: 8,
  fontSize: 14.5,
  fontWeight: 600,
} as const;

const linkBtn = {
  background: "none",
  border: "none",
  padding: "6px 4px",
  cursor: "pointer",
} as const;

export default function Login({
  mode,
  codeInput,
  email,
  staffCode,
  codeError,
  staffError,
  busy,
  onCode,
  onEmail,
  onStaffCode,
  onSubmit,
  onStaffSubmit,
  onMode,
  twoFactor,
  totpCode,
  onTotpCode,
  onTotpSubmit,
  onCancelTwoFactor,
}: Props) {
  const err = (msg: string) => (
    <div
      role="alert"
      style={{
        marginTop: 12,
        padding: "9px 12px",
        background: C.redTint,
        border: `1px solid ${C.redEdge}`,
        borderRadius: 6,
        fontSize: 13,
        color: C.red,
      }}
    >
      {msg}
    </div>
  );

  return (
    <div className="login-page">
      <div style={{ width: "100%", maxWidth: 380 }}>
        {mode === "group" ? (
          <>
            <img
              src={BenSync}
              alt="BenSync"
              style={{ height: 28, display: "block", margin: "0 auto 26px" }}
            />

            <div style={card}>
              <h1 style={{ margin: "0 0 22px", fontSize: 19, fontWeight: 700, color: C.ink, letterSpacing: "-0.2px" }}>
                Sign in
              </h1>

              <div style={fieldGap}>
                <label htmlFor="access-code" style={labelStyle}>
                  Group Access Code
                </label>
                <input
                  id="access-code"
                  value={codeInput}
                  onChange={(e) => onCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSubmit();
                  }}
                  placeholder="KEN-XXXX-XXXX"
                  autoComplete="off"
                  autoFocus
                  disabled={busy}
                  style={fullInput}
                />
              </div>

              <button onClick={onSubmit} disabled={busy} style={{ ...fullBtn, opacity: busy ? 0.6 : 1 }}>
                {busy ? "Checking…" : "Continue"}
              </button>

              {codeError && err("That code doesn't match a group. Check the letter we sent, or email us.")}
            </div>

            <div
              style={{
                marginTop: 18,
                textAlign: "center",
                fontSize: 12.5,
                lineHeight: 1.7,
                color: C.faint,
              }}
            >
              Don't have your code? Email <a href="mailto:support@kennion.com">support@kennion.com</a>
              <div style={{ marginTop: 2 }}>
                <button
                  onClick={() => onMode("staff")}
                  style={{ ...linkBtn, fontSize: 12, color: C.faint, textDecoration: "underline" }}
                >
                  Admin
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <img
              src={Logo}
              alt="Kennion Benefit Advisors"
              style={{ height: 26, display: "block", margin: "0 auto 26px" }}
            />

            <div style={card}>
              <h1 style={{ margin: "0 0 22px", fontSize: 19, fontWeight: 700, color: C.ink, letterSpacing: "-0.2px" }}>
                Staff sign in
              </h1>

              {twoFactor ? (
                <>
                  <div style={fieldGap}>
                    <label htmlFor="staff-totp" style={labelStyle}>
                      Six-digit code from your authenticator app
                    </label>
                    <input
                      id="staff-totp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={totpCode}
                      onChange={(e) => onTotpCode(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onTotpSubmit();
                      }}
                      placeholder="123456"
                      autoFocus
                      disabled={busy}
                      style={{ ...fullInput, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "2px" }}
                    />
                  </div>
                  <button onClick={onTotpSubmit} disabled={busy} style={{ ...fullBtn, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Checking…" : "Continue"}
                  </button>
                  {staffError && err("That code is not right. Try the next one the app shows.")}
                  <div style={{ marginTop: 14, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
                    No phone to hand? Type one of your recovery codes instead - each works once.{" "}
                    <button
                      onClick={onCancelTwoFactor}
                      style={{ ...linkBtn, padding: 0, fontSize: 12.5, color: C.blue }}
                    >
                      Start Again
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={fieldGap}>
                    <label htmlFor="staff-email" style={labelStyle}>
                      Email
                    </label>
                    <input
                      id="staff-email"
                      type="email"
                      value={email}
                      onChange={(e) => onEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onStaffSubmit();
                      }}
                      placeholder="you@kennion.com"
                      autoComplete="username"
                      autoFocus
                      disabled={busy}
                      style={fullInput}
                    />
                  </div>

                  <div style={fieldGap}>
                    <label htmlFor="staff-code" style={labelStyle}>
                      Code
                    </label>
                    <input
                      id="staff-code"
                      type="password"
                      value={staffCode}
                      onChange={(e) => onStaffCode(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") onStaffSubmit();
                      }}
                      autoComplete="current-password"
                      disabled={busy}
                      style={fullInput}
                    />
                  </div>

                  <button onClick={onStaffSubmit} disabled={busy} style={{ ...fullBtn, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Checking…" : "Sign in"}
                  </button>

                  {staffError && err("Email or code not recognised.")}
                </>
              )}
            </div>

            <div style={{ marginTop: 18, textAlign: "center" }}>
              <button onClick={() => onMode("group")} style={{ ...linkBtn, fontSize: 12.5, color: C.faint }}>
                Back To Group Sign In
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
