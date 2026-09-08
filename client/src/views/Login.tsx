import { C, Logo, panel, primaryBtn, textInput } from "@/lib/ui";
import Footer from "@/views/Footer";

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
  marginBottom: 6,
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
        borderRadius: 4,
        fontSize: 13,
        color: C.red,
      }}
    >
      {msg}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: C.page, display: "flex", flexDirection: "column" }}>
      <div style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "0 22px" }}>
        <div
          style={{ maxWidth: 1400, margin: "0 auto", height: 56, display: "flex", alignItems: "center" }}
        >
          <img src={Logo} alt="Kennion Benefit Advisors" style={{ height: 30, display: "block" }} />
        </div>
      </div>

      <div style={{ flex: 1, display: "grid", placeItems: "center", padding: "46px 20px" }}>
        <div style={{ width: "100%", maxWidth: 520 }}>
          {mode === "group" ? (
            <>
              <div style={{ ...panel, padding: "28px 30px 30px" }}>
                <h1
                  style={{
                    margin: "0 0 6px",
                    fontSize: 26,
                    fontWeight: 700,
                    color: C.ink,
                    letterSpacing: "-0.3px",
                    textAlign: "center",
                    textWrap: "balance",
                  }}
                >
                  2027 Employee Benefits Program
                </h1>
                <div
                  style={{
                    margin: "0 0 24px",
                    fontSize: 13.5,
                    color: C.muted,
                    textAlign: "center",
                    textWrap: "balance",
                  }}
                >
                  Health + Dental + Vision + Supplemental
                </div>

                <label htmlFor="access-code" style={labelStyle}>
                  Group access code
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    id="access-code"
                    value={codeInput}
                    onChange={(e) => onCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSubmit();
                    }}
                    placeholder="KEN-XXXX-XXXX"
                    autoComplete="off"
                    disabled={busy}
                    style={{ ...textInput, flex: 1 }}
                  />
                  <button
                    onClick={onSubmit}
                    disabled={busy}
                    style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
                  >
                    {busy ? "Checking…" : "Continue"}
                  </button>
                </div>

                {codeError && err("That code doesn't match a group. Check the letter we sent, or email us.")}

                <div
                  style={{
                    marginTop: 22,
                    paddingTop: 16,
                    borderTop: `1px solid ${C.rule}`,
                    fontSize: 13,
                    lineHeight: 1.7,
                    color: C.muted,
                  }}
                >
                  Don't have your code? Email{" "}
                  <a href="mailto:support@kennion.com">support@kennion.com</a>
                </div>
              </div>

              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button
                  onClick={() => onMode("staff")}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "6px 4px",
                    fontSize: 12,
                    color: C.faint,
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  Admin
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ ...panel, padding: "28px 30px 30px" }}>
                <h1
                  style={{
                    margin: "0 0 22px",
                    fontSize: 22,
                    fontWeight: 600,
                    color: C.ink,
                    letterSpacing: "-0.2px",
                  }}
                >
                  Kennion Staff Sign In
                </h1>

                {twoFactor ? (
                  <>
                    <label htmlFor="staff-totp" style={labelStyle}>
                      Six-digit code from your authenticator app
                    </label>
                    <div style={{ display: "flex", gap: 8 }}>
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
                        style={{ ...textInput, flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "2px" }}
                      />
                      <button onClick={onTotpSubmit} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
                        {busy ? "Checking…" : "Continue"}
                      </button>
                    </div>
                    {staffError && err("That code is not right. Try the next one the app shows.")}
                    <div style={{ marginTop: 12, fontSize: 12.5, color: C.faint, lineHeight: 1.6 }}>
                      No phone to hand? Type one of your recovery codes instead — each works once.{" "}
                      <button
                        onClick={onCancelTwoFactor}
                        style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}
                      >
                        Start again
                      </button>
                    </div>
                  </>
                ) : (
                <>
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
                  disabled={busy}
                  style={{ ...textInput, width: "100%", marginBottom: 14 }}
                />

                <label htmlFor="staff-code" style={labelStyle}>
                  Code
                </label>
                <div style={{ display: "flex", gap: 8 }}>
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
                    style={{ ...textInput, flex: 1 }}
                  />
                  <button
                    onClick={onStaffSubmit}
                    disabled={busy}
                    style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
                  >
                    {busy ? "Checking…" : "Sign in"}
                  </button>
                </div>

                {staffError && err("Email or code not recognised.")}
                </>
                )}
              </div>

              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button
                  onClick={() => onMode("group")}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "6px 4px",
                    fontSize: 13,
                    color: C.blue,
                    cursor: "pointer",
                  }}
                >
                  Back to group sign in
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <Footer />
    </div>
  );
}
