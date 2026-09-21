import { BenSync, BenSyncDark, C, Logo, panel, primaryBtn, textInput } from "@/lib/ui";

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
  borderRadius: 16,
  boxShadow: "0 24px 48px -18px rgba(15,42,71,0.22), 0 2px 8px rgba(15,42,71,0.06)",
  padding: "38px 36px 32px",
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
    <div className="login-split">
      <div
        className="login-brand"
        style={{
          background: "linear-gradient(160deg, #0B2138 0%, #0F2A47 100%)",
          padding: "44px 48px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div>
          <img src={BenSyncDark} alt="BenSync" style={{ height: 30, display: "block" }} />
          <div style={{ marginTop: 8, fontSize: 12.5, color: C.railMuted }}>Powered By Kennion Benefit Advisors</div>
        </div>

        <div style={{ maxWidth: 460 }}>
          <h1 style={{ margin: "0 0 10px", fontSize: 30, fontWeight: 700, color: "#fff", letterSpacing: "-0.5px", lineHeight: 1.2, textWrap: "balance" }}>
            {mode === "group" ? "Smarter benefits. Lower costs." : "The Kennion staff portal."}
          </h1>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.4px", color: C.teal, textTransform: "uppercase" }}>
            {mode === "group" ? "Modern Benefits Brokerage" : "Internal Access"}
          </div>
        </div>
      </div>

      <div style={{ background: C.page, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: "24px 20px 46px" }}>
          <div style={{ width: "100%", maxWidth: 400 }}>
            {mode === "group" ? (
              <>
                <div style={card}>
                  <img src={BenSync} alt="BenSync" style={{ height: 26, display: "block", marginBottom: 22 }} />
                  <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: C.ink, letterSpacing: "-0.3px" }}>
                    Welcome
                  </h2>
                  <div style={{ margin: "0 0 24px", fontSize: 13.5, color: C.muted }}>
                    Health + Dental + Vision + Supplemental
                  </div>

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
                      disabled={busy}
                      style={fullInput}
                    />
                  </div>

                  <button onClick={onSubmit} disabled={busy} style={{ ...fullBtn, opacity: busy ? 0.6 : 1 }}>
                    {busy ? "Checking…" : "Continue"}
                  </button>

                  {codeError && err("That code doesn't match a group. Check the letter we sent, or email us.")}

                  <div
                    style={{
                      marginTop: 22,
                      paddingTop: 16,
                      borderTop: `1px solid ${C.rule}`,
                      fontSize: 13,
                      lineHeight: 1.7,
                      color: C.muted,
                      textAlign: "center",
                    }}
                  >
                    Don't have your code? Email{" "}
                    <a href="mailto:support@kennion.com">support@kennion.com</a>
                  </div>
                </div>

                <div style={{ marginTop: 16, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
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
                <div style={card}>
                  <img src={Logo} alt="Kennion Benefit Advisors" style={{ height: 24, display: "block", marginBottom: 22 }} />
                  <h2 style={{ margin: "0 0 22px", fontSize: 20, fontWeight: 700, color: C.ink, letterSpacing: "-0.2px" }}>
                    Kennion Staff Sign In
                  </h2>

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
                          style={{ background: "none", border: "none", padding: 0, fontSize: 12.5, color: C.blue, cursor: "pointer" }}
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
                    Back To Group Sign In
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
