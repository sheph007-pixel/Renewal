// Postgres storage for imported groups and hand-keyed rates.
//
// Optional by design: with no DATABASE_URL the portal runs exactly as before,
// serving the shipped census and keeping imports in a JSON file. That keeps a
// missing or misconfigured database from taking the site down.
//
// Where a database IS configured it is the source of truth for everything a
// human has entered — imported groups, their contribution splits, and rate
// overrides — so it survives redeploys and is shared across the team rather
// than living in one browser.
import pg from "pg";

// Everything lives in its own `kennion` schema. The database may already carry
// tables from a previous application — the first import failed because a
// legacy `public.groups` existed with a different shape, so CREATE TABLE IF NOT
// EXISTS silently did nothing and the insert hit the wrong columns. A dedicated
// schema cannot collide, and leaves anything already in `public` untouched.
const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS kennion;

CREATE TABLE IF NOT EXISTS kennion.groups (
  name            text PRIMARY KEY,
  en_identifier   text,
  access_code     text,
  payload         jsonb NOT NULL,
  split           jsonb,
  source          text NOT NULL DEFAULT 'import',
  imported_at     timestamptz NOT NULL DEFAULT now(),
  imported_by     text
);
CREATE INDEX IF NOT EXISTS groups_access_code_idx ON kennion.groups (access_code);

-- Editable identity for every group, imported or straight from the census:
-- the access code staff assign, and the ALE bucket, which is a judgement they
-- make rather than something the enrollment count can settle on its own.
CREATE TABLE IF NOT EXISTS kennion.group_meta (
  group_name     text PRIMARY KEY,
  company_id     text UNIQUE,
  size_category  text CHECK (size_category IN ('2-50','51+')),
  archived       boolean NOT NULL DEFAULT false,
  -- Hand-edited company details, layered over whatever the export supplied so
  -- a correction is not undone by the next import.
  fields         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS fields jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Who brokers the group: Kennion directly, or an outside broker. Only the
-- label is stored, never the broker's name.
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS broker text CHECK (broker IN ('kennion','outside'));
-- The Kennion account manager who looks after the group.
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS manager text CHECK (manager IN ('debbie','tracy'));
-- The group's permanent link: a random, unguessable token in the address, so
-- the page can be bookmarked and shared without typing a code. Reset it and
-- the old link stops working.
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS link_token text;
CREATE UNIQUE INDEX IF NOT EXISTS group_meta_link_token_idx ON kennion.group_meta (link_token);

-- Two-factor enrolment for staff. The shared secret is what an authenticator
-- app holds; recovery codes are stored only as hashes, so the row is no use to
-- anyone who reads it.
CREATE TABLE IF NOT EXISTS kennion.staff_auth (
  email          text PRIMARY KEY,
  totp_secret    text,
  confirmed_at   timestamptz,
  recovery       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- The sign-in code itself, kept as a scrypt hash so the row cannot be read
-- back into a working code. Stored here rather than in an environment
-- variable so it survives a restart without anyone having to configure the
-- host, and so it can be changed from inside the app.
ALTER TABLE kennion.staff_auth ADD COLUMN IF NOT EXISTS code_hash text;
-- Where the 2027 renewal stands, for tracking. Null means Open.
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS renewal text CHECK (renewal IN ('open','sent','renewed','non-renewed'));

-- One row per upload, so the admin screen can say when data last came in and
-- from which file.
CREATE TABLE IF NOT EXISTS kennion.imports (
  id            bigserial PRIMARY KEY,
  filename      text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   text,
  companies_found   integer,
  companies_applied integer,
  applied_names text[]
);
ALTER TABLE kennion.imports ADD COLUMN IF NOT EXISTS diagnostics jsonb;

-- Carrier proposals, one row per uploaded file. The file itself lives here so
-- a proposal is never lost to an ephemeral container; the extraction is what
-- Claude read off it, and status says whether a human has confirmed the group.
CREATE TABLE IF NOT EXISTS kennion.proposals (
  id            bigserial PRIMARY KEY,
  group_name    text,
  carrier       text,
  filename      text NOT NULL,
  mime          text NOT NULL,
  size          integer NOT NULL,
  data          bytea NOT NULL,
  extracted     jsonb,
  summary       text,
  confidence    real,
  status        text NOT NULL DEFAULT 'analyzing',
  assigned_by   text,
  error         text,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposals_group_idx ON kennion.proposals (group_name);
-- An email is stored as its own row (kind 'email'); each attachment pulled out
-- of it is a row of kind 'attachment' pointing back at it, carrying the
-- email's subject, sender and body as context for the match.
ALTER TABLE kennion.proposals ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'file';
ALTER TABLE kennion.proposals ADD COLUMN IF NOT EXISTS parent_id bigint;
ALTER TABLE kennion.proposals ADD COLUMN IF NOT EXISTS context jsonb;
-- Which of a group's proposal slots this fills (UHC Fully Insured, UHC Level
-- Funded, Gravie, Nationwide…). A newer proposal in the same slot supersedes
-- the older one, which is kept and marked.
ALTER TABLE kennion.proposals ADD COLUMN IF NOT EXISTS slot text;
ALTER TABLE kennion.proposals ADD COLUMN IF NOT EXISTS superseded_by bigint;

-- Employee Navigator's Carrier Stats report, one row per upload. The latest
-- one is the independent check the XML import is reconciled against.
CREATE TABLE IF NOT EXISTS kennion.carrier_stats (
  id            bigserial PRIMARY KEY,
  filename      text,
  report_date   date,
  rows          jsonb NOT NULL,
  total         jsonb,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- A month's funding workbook: every billed line (participant names included —
-- server-side only, like the members), which invoice went to which group,
-- and the per-group summary the screens use. Latest upload wins.
CREATE TABLE IF NOT EXISTS kennion.funding (
  id            bigserial PRIMARY KEY,
  month         text,
  filename      text,
  file_stamp    text,
  lines         jsonb NOT NULL,
  by_invoice    jsonb NOT NULL,
  summary       jsonb NOT NULL,
  uploaded_by   text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The audit that runs itself once the three files are in: the computed
-- result and Claude's read of it, keyed by which uploads it covered, so a
-- restart or a second look never re-runs the model for the same files.
CREATE TABLE IF NOT EXISTS kennion.audits (
  fingerprint   text PRIMARY KEY,
  result        jsonb NOT NULL,
  read          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kennion.rate_overrides (
  group_name   text NOT NULL,
  plan         text NOT NULL,
  census_tier  text NOT NULL,
  rate         numeric(12,2) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (group_name, plan, census_tier)
);
`;

const shapeStats = (r) => ({
  filename: r.filename,
  reportDate: r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date ? String(r.report_date).slice(0, 10) : null,
  rows: r.rows,
  total: r.total,
  uploadedAt: r.uploaded_at,
  uploadedBy: r.uploaded_by,
});

export function createDb(url) {
  if (!url) return null;

  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway's internal Postgres presents a self-signed certificate.
    ssl: /\bsslmode=disable\b/.test(url) || /localhost|127\.0\.0\.1/.test(url)
      ? false
      : { rejectUnauthorized: false },
  });

  pool.on("error", (e) => console.error("postgres pool error:", e.message));

  return {
    async init() {
      await pool.query(SCHEMA);
    },

    /** Everything a human has entered, as the overlay the server applies. */
    async load() {
      const groups = {};
      const splits = {};
      const { rows } = await pool.query(
        "SELECT name, payload, split, imported_at FROM kennion.groups ORDER BY name",
      );
      for (const r of rows) {
        groups[r.name] = r.payload;
        if (r.split) splits[r.name] = r.split;
      }

      const meta = {};
      const mrows = await pool.query(
        "SELECT group_name, company_id, size_category, archived, fields, broker, renewal, manager, link_token FROM kennion.group_meta",
      );
      for (const r of mrows.rows) {
        meta[r.group_name] = {
          companyId: r.company_id,
          sizeCategory: r.size_category,
          archived: r.archived,
          fields: r.fields || {},
          broker: r.broker || null,
          manager: r.manager || null,
          linkToken: r.link_token || null,
          renewal: r.renewal || null,
        };
      }

      const overrides = {};
      const ov = await pool.query(
        "SELECT group_name, plan, census_tier, rate FROM kennion.rate_overrides",
      );
      for (const r of ov.rows) {
        overrides[`${r.group_name}||${r.plan}||${r.census_tier}`] = String(r.rate);
      }
      const importedAt = {};
      for (const r of rows) importedAt[r.name] = r.imported_at;

      return { groups, splits, overrides, meta, importedAt };
    },

    /** One imported group. Re-importing the same group replaces it. */
    async saveGroup(group, split, by) {
      await pool.query(
        `INSERT INTO kennion.groups (name, en_identifier, access_code, payload, split, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (name) DO UPDATE SET
           en_identifier = EXCLUDED.en_identifier,
           access_code   = EXCLUDED.access_code,
           payload       = EXCLUDED.payload,
           split         = EXCLUDED.split,
           imported_at   = now(),
           imported_by   = EXCLUDED.imported_by`,
        [group.name, group.enIdentifier || null, group.code || null, group, split || null, by || null],
      );
    },

    /** Staff edit to a group's code, ALE bucket, broker label, renewal state, or archived state. */
    async setMeta(groupName, field, value, by) {
      const col =
        field === "companyId"
          ? "company_id"
          : field === "archived"
            ? "archived"
            : field === "broker"
              ? "broker"
              : field === "manager"
                ? "manager"
                : field === "linkToken"
                  ? "link_token"
              : field === "renewal"
                ? "renewal"
                : "size_category";
      await pool.query(
        `INSERT INTO kennion.group_meta (group_name, ${col}, updated_by)
         VALUES ($1,$2,$3)
         ON CONFLICT (group_name) DO UPDATE SET
           ${col} = EXCLUDED.${col}, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [groupName, field === "archived" ? !!value : value || null, by || null],
      );
    },

    /** Two-factor enrolment for one staff member, or null. */
    async staffAuth(email) {
      const { rows } = await pool.query(
        "SELECT email, totp_secret, confirmed_at, recovery, code_hash FROM kennion.staff_auth WHERE email = $1",
        [email],
      );
      return rows[0] || null;
    },

    /** The stored sign-in code hash for one staff member, or null. */
    async staffCodeHash(email) {
      const { rows } = await pool.query(
        "SELECT code_hash FROM kennion.staff_auth WHERE email = $1",
        [email],
      );
      return (rows[0] && rows[0].code_hash) || null;
    },

    /**
     * Store the sign-in code hash, leaving any two-factor enrolment alone.
     * Written on its own so changing the code never disturbs the second
     * factor, and vice versa.
     */
    async saveStaffCodeHash(email, codeHash) {
      await pool.query(
        `INSERT INTO kennion.staff_auth (email, code_hash, updated_at)
         VALUES ($1,$2, now())
         ON CONFLICT (email) DO UPDATE SET
           code_hash = EXCLUDED.code_hash,
           updated_at = now()`,
        [email, codeHash || null],
      );
    },

    /** Store or replace an enrolment. */
    async saveStaffAuth(email, { totpSecret, confirmedAt, recovery }) {
      await pool.query(
        `INSERT INTO kennion.staff_auth (email, totp_secret, confirmed_at, recovery, updated_at)
         VALUES ($1,$2,$3,$4::jsonb, now())
         ON CONFLICT (email) DO UPDATE SET
           totp_secret = EXCLUDED.totp_secret,
           confirmed_at = EXCLUDED.confirmed_at,
           recovery = EXCLUDED.recovery,
           updated_at = now()`,
        [email, totpSecret || null, confirmedAt || null, JSON.stringify(recovery || [])],
      );
    },

    /** One hand-edited company detail, merged into the fields object. */
    async setField(groupName, key, value, by) {
      await pool.query(
        `INSERT INTO kennion.group_meta (group_name, fields, updated_by)
         VALUES ($1, jsonb_build_object($2::text, $3::text), $4)
         ON CONFLICT (group_name) DO UPDATE SET
           fields = kennion.group_meta.fields || jsonb_build_object($2::text, $3::text),
           updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [groupName, key, value == null || value === "" ? null : String(value), by || null],
      );
    },

    async setOverride(groupName, plan, censusTier, rate, by) {
      if (rate == null || rate === "") {
        await pool.query(
          "DELETE FROM kennion.rate_overrides WHERE group_name=$1 AND plan=$2 AND census_tier=$3",
          [groupName, plan, censusTier],
        );
        return;
      }
      await pool.query(
        `INSERT INTO kennion.rate_overrides (group_name, plan, census_tier, rate, updated_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (group_name, plan, census_tier) DO UPDATE SET
           rate = EXCLUDED.rate, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [groupName, plan, censusTier, rate, by || null],
      );
    },

    async logImport(filename, by, found, applied, names, diagnostics) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.imports
           (filename, uploaded_by, companies_found, companies_applied, applied_names, diagnostics)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING uploaded_at`,
        [filename || null, by || null, found, applied, names || [], diagnostics ? JSON.stringify(diagnostics) : null],
      );
      return rows[0].uploaded_at;
    },

    /** Most recent uploads, newest first, for the import history panel. */
    async recentImports(limit = 8) {
      const { rows } = await pool.query(
        `SELECT filename, uploaded_at, uploaded_by, companies_found, companies_applied, diagnostics
           FROM kennion.imports ORDER BY uploaded_at DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },

    /** Store one uploaded proposal file. Returns the row without its bytes. */
    async addProposal(p) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.proposals
           (group_name, carrier, filename, mime, size, data, status, assigned_by, uploaded_by,
            kind, parent_id, context)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, group_name, carrier, filename, mime, size, extracted, summary, confidence,
                   status, assigned_by, error, uploaded_by, uploaded_at, updated_at,
                   kind, parent_id, context, slot, superseded_by`,
        [
          p.group_name || null, p.carrier || null, p.filename, p.mime, p.size, p.data,
          p.status || "analyzing", p.assigned_by || null, p.uploaded_by || null,
          p.kind || "file", p.parent_id || null, p.context ? JSON.stringify(p.context) : null,
        ],
      );
      return rows[0];
    },

    /** Every proposal, newest first, without the file bytes. */
    async listProposals() {
      const { rows } = await pool.query(
        `SELECT id, group_name, carrier, filename, mime, size, extracted, summary, confidence,
                status, assigned_by, error, uploaded_by, uploaded_at, updated_at,
                kind, parent_id, context, slot, superseded_by
           FROM kennion.proposals ORDER BY uploaded_at DESC, id DESC`,
      );
      return rows;
    },

    /** Change any of the reviewable fields on a proposal. */
    async updateProposal(id, fields) {
      const allowed = ["group_name", "carrier", "extracted", "summary", "confidence", "status", "assigned_by", "error", "slot", "superseded_by"];
      const sets = [];
      const vals = [];
      for (const k of allowed) {
        if (!(k in fields)) continue;
        vals.push(k === "extracted" ? JSON.stringify(fields[k]) : fields[k]);
        sets.push(`${k} = $${vals.length}${k === "extracted" ? "::jsonb" : ""}`);
      }
      if (!sets.length) return null;
      vals.push(id);
      const { rows } = await pool.query(
        `UPDATE kennion.proposals SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $${vals.length}
          RETURNING id, group_name, carrier, filename, mime, size, extracted, summary, confidence,
                    status, assigned_by, error, uploaded_by, uploaded_at, updated_at,
                    kind, parent_id, context, slot, superseded_by`,
        vals,
      );
      return rows[0] || null;
    },

    /** The stored file, for download or re-analysis. */
    async getProposalFile(id) {
      const { rows } = await pool.query(
        "SELECT filename, mime, data FROM kennion.proposals WHERE id = $1",
        [id],
      );
      return rows[0] || null;
    },

    async deleteProposal(id) {
      // An email takes its attachments with it.
      const { rowCount } = await pool.query(
        "DELETE FROM kennion.proposals WHERE id = $1 OR parent_id = $1",
        [id],
      );
      return rowCount > 0;
    },

    /** Keep a carrier stats report. Returns it in the shape the client uses. */
    async saveAudit(fingerprint, result, read) {
      await pool.query(
        `INSERT INTO kennion.audits (fingerprint, result, read) VALUES ($1,$2,$3)
         ON CONFLICT (fingerprint) DO UPDATE SET result = EXCLUDED.result, read = COALESCE(EXCLUDED.read, kennion.audits.read), updated_at = now()`,
        [fingerprint, JSON.stringify(result), read || null],
      );
    },

    async getAudit(fingerprint) {
      const { rows } = await pool.query("SELECT result, read, created_at FROM kennion.audits WHERE fingerprint = $1", [fingerprint]);
      return rows[0] ? { result: rows[0].result, read: rows[0].read, createdAt: rows[0].created_at } : null;
    },

    async saveCarrierStats(rec) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.carrier_stats (filename, report_date, rows, total, uploaded_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING filename, report_date, rows, total, uploaded_by, uploaded_at`,
        [rec.filename || null, rec.reportDate || null, JSON.stringify(rec.rows), rec.total ? JSON.stringify(rec.total) : null, rec.uploadedBy || null],
      );
      return shapeStats(rows[0]);
    },

    async latestCarrierStats() {
      const { rows } = await pool.query(
        `SELECT filename, report_date, rows, total, uploaded_by, uploaded_at
           FROM kennion.carrier_stats ORDER BY uploaded_at DESC, id DESC LIMIT 1`,
      );
      return rows[0] ? shapeStats(rows[0]) : null;
    },

    async saveFunding(rec) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.funding (month, filename, file_stamp, lines, by_invoice, summary, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, month, filename, file_stamp, by_invoice, summary, uploaded_by, uploaded_at`,
        [rec.month, rec.filename, rec.fileStamp, JSON.stringify(rec.lines), JSON.stringify(rec.byInvoice), JSON.stringify(rec.summary), rec.uploadedBy || null],
      );
      return rows[0];
    },

    async latestFunding() {
      const { rows } = await pool.query(
        `SELECT id, month, filename, file_stamp, lines, by_invoice, summary, uploaded_by, uploaded_at
           FROM kennion.funding ORDER BY uploaded_at DESC, id DESC LIMIT 1`,
      );
      return rows[0] || null;
    },

    async updateFunding(id, byInvoice, summary) {
      await pool.query(
        "UPDATE kennion.funding SET by_invoice = $2, summary = $3, updated_at = now() WHERE id = $1",
        [id, JSON.stringify(byInvoice), JSON.stringify(summary)],
      );
    },

    async stats() {
      const g = await pool.query("SELECT count(*)::int n FROM kennion.groups");
      const o = await pool.query("SELECT count(*)::int n FROM kennion.rate_overrides");
      return { groups: g.rows[0].n, overrides: o.rows[0].n };
    },

    async close() {
      await pool.end();
    },
  };
}
