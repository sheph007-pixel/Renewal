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

-- Small pieces of state that belong to the whole portal rather than to one
-- group: whether the rates are locked, and who locked them.
CREATE TABLE IF NOT EXISTS kennion.settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
-- Where the 2027 renewal stands, for tracking. Null means Open.
ALTER TABLE kennion.group_meta ADD COLUMN IF NOT EXISTS renewal text CHECK (renewal IN ('open','sent','renewed','non-renewed'));

-- What a group submitted on its own Sign Up page: the plans it shortlisted
-- and any note, timestamped. One row per submission, so a second submission
-- does not erase the first — staff see the history, not just the latest.
CREATE TABLE IF NOT EXISTS kennion.group_signups (
  id            bigserial PRIMARY KEY,
  group_name    text NOT NULL,
  plans         jsonb NOT NULL DEFAULT '[]'::jsonb,
  note          text,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_signups_group_idx ON kennion.group_signups (group_name);

-- A support ticket a client sends from the portal; emailed to Kennion and
-- kept here so nothing is lost if the email does not go out.
CREATE TABLE IF NOT EXISTS kennion.support_tickets (
  id            bigserial PRIMARY KEY,
  group_name    text NOT NULL,
  priority      text NOT NULL DEFAULT 'Low',
  requester     text NOT NULL,
  subject       text NOT NULL,
  description   text NOT NULL,
  attachment    text,
  emailed_at    timestamptz,
  email_error   text,
  submitted_at  timestamptz NOT NULL DEFAULT now()
);

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
-- The export itself, gzip-compressed (XML compresses to a fraction of its
-- size), so the source of every import is on hand for anything a later fix
-- needs to recompute — no one has to go find the file and upload it again.
ALTER TABLE kennion.imports ADD COLUMN IF NOT EXISTS raw_gzip bytea;
ALTER TABLE kennion.imports ADD COLUMN IF NOT EXISTS raw_size integer;

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
-- The report file itself, gzip-compressed, same reasoning as an import's
-- raw_gzip: on hand for good, nothing to re-upload if a fix ever needs it.
ALTER TABLE kennion.carrier_stats ADD COLUMN IF NOT EXISTS raw_gzip bytea;

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
ALTER TABLE kennion.funding ADD COLUMN IF NOT EXISTS raw_gzip bytea;

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

-- A carrier's rate quote for one group, read straight off the carrier's own
-- workbook and kept as rows rather than a blob: one quote per carrier and
-- group (a newer workbook replaces the older rows), and under it every plan
-- the carrier priced, with its four tier rates. Gravie's rate workbooks fill
-- these today; the proposal record keeps the file itself.
CREATE TABLE IF NOT EXISTS kennion.carrier_quotes (
  id             bigserial PRIMARY KEY,
  carrier        text NOT NULL,
  group_name     text NOT NULL,
  quote_number   text,
  effective_date date,
  generated      date,
  network        text,
  tiers          jsonb NOT NULL,
  plan_count     integer NOT NULL,
  filename       text,
  proposal_id    bigint,
  uploaded_by    text,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (carrier, group_name)
);
CREATE TABLE IF NOT EXISTS kennion.carrier_quote_plans (
  quote_id     bigint NOT NULL REFERENCES kennion.carrier_quotes(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  plan_name    text NOT NULL,
  plan_type    text,
  network      text NOT NULL,
  deductible   text,
  oop_max      text,
  coinsurance  numeric(5,2),
  rate_ee      numeric(12,2),
  rate_es      numeric(12,2),
  rate_ec      numeric(12,2),
  rate_fam     numeric(12,2),
  monthly      numeric(12,2),
  PRIMARY KEY (quote_id, position)
);
CREATE INDEX IF NOT EXISTS carrier_quote_plans_network_idx ON kennion.carrier_quote_plans (quote_id, network);

-- Each carrier's logo, uploaded once by staff and shown wherever the carrier
-- is named: the options grid, plan cards, documents.
CREATE TABLE IF NOT EXISTS kennion.carrier_logos (
  carrier      text PRIMARY KEY,
  mime         text NOT NULL,
  data         bytea NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
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

-- A client's conversations with the assistant, one thread per conversation
-- and its turns beneath it. Scoped to the group, so an employer only ever
-- sees its own; the assistant's answers are kept so a thread reads back the
-- same way it was written.
CREATE TABLE IF NOT EXISTS kennion.chat_threads (
  id            bigserial PRIMARY KEY,
  group_name    text NOT NULL,
  title         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_threads_group_idx ON kennion.chat_threads (group_name, updated_at DESC);
CREATE TABLE IF NOT EXISTS kennion.chat_messages (
  id            bigserial PRIMARY KEY,
  thread_id     bigint NOT NULL REFERENCES kennion.chat_threads(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('user','assistant')),
  content       text NOT NULL,
  page          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_idx ON kennion.chat_messages (thread_id, id);
-- Staff can try the assistant as any group from the admin; those threads are
-- kept for the record but never shown to the client. A thread can be flagged
-- for follow-up by the account manager, with a note.
ALTER TABLE kennion.chat_threads ADD COLUMN IF NOT EXISTS staff boolean NOT NULL DEFAULT false;
ALTER TABLE kennion.chat_threads ADD COLUMN IF NOT EXISTS flagged_at timestamptz;
ALTER TABLE kennion.chat_threads ADD COLUMN IF NOT EXISTS flag_note text;
-- Documents the assistant produced for a turn — a comparison, a memo — as
-- [{id, filename, mime, size}], the bytes in chat_files.
ALTER TABLE kennion.chat_messages ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS kennion.chat_files (
  id            bigserial PRIMARY KEY,
  thread_id     bigint REFERENCES kennion.chat_threads(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  mime          text NOT NULL,
  size          integer NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- A client can attach a file to a question. It is uploaded first, held for
-- the group with no thread, then claimed by the message that sends it; one
-- left unclaimed is swept after a day. role says who put it there.
ALTER TABLE kennion.chat_files ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE kennion.chat_files ADD COLUMN IF NOT EXISTS group_name text;
ALTER TABLE kennion.chat_files ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'assistant';
-- What the assistant remembers about a group between conversations: the
-- preferences the client stated (budget, priorities, must-haves, what they
-- ruled out). One line each; the client and staff can remove any of them.
CREATE TABLE IF NOT EXISTS kennion.client_memory (
  id            bigserial PRIMARY KEY,
  group_name    text NOT NULL,
  text          text NOT NULL,
  source        text NOT NULL DEFAULT 'client',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_memory_group ON kennion.client_memory (group_name, created_at);
-- A benchmarks table shipped briefly and was taken out; the assistant answers
-- "how do we compare" from the web instead.
DROP TABLE IF EXISTS kennion.benchmarks;
`;

const shapeThread = (r) => ({
  id: Number(r.id),
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.group_name !== undefined ? { groupName: r.group_name } : {}),
  ...(r.staff !== undefined ? { staff: !!r.staff } : {}),
  ...(r.flagged_at !== undefined ? { flaggedAt: r.flagged_at, flagNote: r.flag_note || null } : {}),
  ...(r.n !== undefined ? { messages: Number(r.n), preview: r.preview || null } : {}),
});
const shapeMessage = (r) => ({ id: Number(r.id), role: r.role, content: r.content, page: r.page, files: r.files || [], createdAt: r.created_at });

const shapeStats = (r) => ({
  filename: r.filename,
  reportDate: r.report_date instanceof Date ? r.report_date.toISOString().slice(0, 10) : r.report_date ? String(r.report_date).slice(0, 10) : null,
  rows: r.rows,
  total: r.total,
  uploadedAt: r.uploaded_at,
  uploadedBy: r.uploaded_by,
});

const num = (v) => (v == null ? null : Number(v));
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const shapeQuote = (r) => ({
  id: r.id,
  carrier: r.carrier,
  groupName: r.group_name,
  quoteNumber: r.quote_number,
  effectiveDate: day(r.effective_date),
  generated: day(r.generated),
  network: r.network,
  tiers: r.tiers,
  planCount: r.plan_count,
  filename: r.filename,
  proposalId: r.proposal_id,
  uploadedBy: r.uploaded_by,
  uploadedAt: r.uploaded_at,
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

    /**
     * Rewrite a group's payload in place — a field filled in from the stored
     * export, say — without touching when or by whom it was imported.
     */
    async updateGroupPayload(name, payload) {
      await pool.query("UPDATE kennion.groups SET payload = $2 WHERE name = $1", [name, payload]);
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

    /** A group's own submission: its shortlisted plans and note. One row kept per submission. */
    async addSignup(groupName, plans, note) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.group_signups (group_name, plans, note)
         VALUES ($1, $2::jsonb, $3)
         RETURNING id, group_name, plans, note, submitted_at`,
        [groupName, JSON.stringify(plans || []), note || null],
      );
      return rows[0];
    },

    async addSupportTicket(t) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.support_tickets (group_name, priority, requester, subject, description, attachment)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, group_name, priority, requester, subject, submitted_at`,
        [t.groupName, t.priority, t.requester, t.subject, t.description, t.attachment || null],
      );
      return rows[0];
    },
    async markSupportTicketEmailed(id, error) {
      await pool.query(
        `UPDATE kennion.support_tickets SET emailed_at = CASE WHEN $2::text IS NULL THEN now() ELSE emailed_at END, email_error = $2 WHERE id = $1`,
        [id, error || null],
      );
    },

    /** Every submission a group has made, newest first. */
    async listSignups(groupName) {
      const { rows } = await pool.query(
        `SELECT id, group_name, plans, note, submitted_at FROM kennion.group_signups
         WHERE group_name = $1 ORDER BY submitted_at DESC, id DESC`,
        [groupName],
      );
      return rows;
    },

    /** Two-factor enrolment for one staff member, or null. */
    async staffAuth(email) {
      const { rows } = await pool.query(
        "SELECT email, totp_secret, confirmed_at, recovery, code_hash FROM kennion.staff_auth WHERE email = $1",
        [email],
      );
      return rows[0] || null;
    },

    /** One portal-wide setting, or null when it has never been set. */
    async getSetting(key) {
      const { rows } = await pool.query("SELECT value FROM kennion.settings WHERE key = $1", [key]);
      return rows[0] ? rows[0].value : null;
    },

    /** Store one portal-wide setting. */
    async setSetting(key, value, by) {
      await pool.query(
        `INSERT INTO kennion.settings (key, value, updated_at, updated_by)
         VALUES ($1, $2::jsonb, now(), $3)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(value), by || null],
      );
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

    async logImport(filename, by, found, applied, names, diagnostics, rawGzip) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.imports
           (filename, uploaded_by, companies_found, companies_applied, applied_names, diagnostics, raw_gzip, raw_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING uploaded_at`,
        [
          filename || null,
          by || null,
          found,
          applied,
          names || [],
          diagnostics ? JSON.stringify(diagnostics) : null,
          rawGzip || null,
          rawGzip ? rawGzip.length : null,
        ],
      );
      return rows[0].uploaded_at;
    },

    /** The gzip-compressed export behind one import, to reprocess without asking for the file again. */
    async importRaw(id) {
      const { rows } = await pool.query(
        `SELECT filename, raw_gzip, raw_size FROM kennion.imports WHERE id = $1`,
        [id],
      );
      return rows[0] || null;
    },

    /** Most recent uploads, newest first, for the import history panel. */
    async recentImports(limit = 8) {
      const { rows } = await pool.query(
        `SELECT id, filename, uploaded_at, uploaded_by, companies_found, companies_applied, diagnostics, raw_size
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
        `INSERT INTO kennion.carrier_stats (filename, report_date, rows, total, uploaded_by, raw_gzip)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING filename, report_date, rows, total, uploaded_by, uploaded_at`,
        [
          rec.filename || null,
          rec.reportDate || null,
          JSON.stringify(rec.rows),
          rec.total ? JSON.stringify(rec.total) : null,
          rec.uploadedBy || null,
          rec.rawGzip || null,
        ],
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
        `INSERT INTO kennion.funding (month, filename, file_stamp, lines, by_invoice, summary, uploaded_by, raw_gzip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, month, filename, file_stamp, by_invoice, summary, uploaded_by, uploaded_at`,
        [
          rec.month,
          rec.filename,
          rec.fileStamp,
          JSON.stringify(rec.lines),
          JSON.stringify(rec.byInvoice),
          JSON.stringify(rec.summary),
          rec.uploadedBy || null,
          rec.rawGzip || null,
        ],
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

    /**
     * Store a carrier's quote for a group as rows, replacing any earlier quote
     * from the same carrier for the same group. `plans` are in workbook order.
     */
    async replaceCarrierQuote(q, plans) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM kennion.carrier_quotes WHERE carrier = $1 AND group_name = $2", [q.carrier, q.groupName]);
        const { rows } = await client.query(
          `INSERT INTO kennion.carrier_quotes
             (carrier, group_name, quote_number, effective_date, generated, network, tiers, plan_count, filename, proposal_id, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [q.carrier, q.groupName, q.quoteNumber || null, q.effectiveDate || null, q.generated || null, q.network || null,
           JSON.stringify(q.tiers || {}), plans.length, q.filename || null, q.proposalId || null, q.uploadedBy || null],
        );
        const id = rows[0].id;
        // One multi-row insert per 50 plans keeps a 134-plan quote to three round trips.
        for (let i = 0; i < plans.length; i += 50) {
          const chunk = plans.slice(i, i + 50);
          const vals = [];
          const ph = chunk.map((pl, j) => {
            const k = vals.length;
            vals.push(id, i + j, pl.name, pl.planType || null, pl.network, pl.deductible || null, pl.oopMax || null,
              pl.coinsurance ?? null, pl.rates.EE ?? null, pl.rates.ES ?? null, pl.rates.EC ?? null, pl.rates.FAM ?? null, pl.monthly ?? null);
            return `(${Array.from({ length: 13 }, (_, n) => `$${k + n + 1}`).join(",")})`;
          });
          await client.query(
            `INSERT INTO kennion.carrier_quote_plans
               (quote_id, position, plan_name, plan_type, network, deductible, oop_max, coinsurance, rate_ee, rate_es, rate_ec, rate_fam, monthly)
             VALUES ${ph.join(",")}`,
            vals,
          );
        }
        await client.query("COMMIT");
        return id;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },

    /** Every stored quote, one row per carrier and group, without the plans. */
    async listCarrierQuotes(carrier) {
      const { rows } = await pool.query(
        `SELECT id, carrier, group_name, quote_number, effective_date, generated, network, tiers, plan_count, filename, proposal_id, uploaded_by, uploaded_at
           FROM kennion.carrier_quotes ${carrier ? "WHERE carrier = $1" : ""} ORDER BY carrier, group_name`,
        carrier ? [carrier] : [],
      );
      return rows.map(shapeQuote);
    },

    /** One group's quote from a carrier, with its plans in workbook order. */
    async carrierQuote(carrier, groupName) {
      const { rows } = await pool.query(
        `SELECT id, carrier, group_name, quote_number, effective_date, generated, network, tiers, plan_count, filename, proposal_id, uploaded_by, uploaded_at
           FROM kennion.carrier_quotes WHERE carrier = $1 AND group_name = $2`,
        [carrier, groupName],
      );
      if (!rows[0]) return null;
      const { rows: plans } = await pool.query(
        `SELECT position, plan_name, plan_type, network, deductible, oop_max, coinsurance, rate_ee, rate_es, rate_ec, rate_fam, monthly
           FROM kennion.carrier_quote_plans WHERE quote_id = $1 ORDER BY position`,
        [rows[0].id],
      );
      return {
        ...shapeQuote(rows[0]),
        plans: plans.map((pl) => ({
          name: pl.plan_name,
          planType: pl.plan_type,
          network: pl.network,
          deductible: pl.deductible,
          oopMax: pl.oop_max,
          coinsurance: pl.coinsurance == null ? null : Number(pl.coinsurance),
          rates: { EE: num(pl.rate_ee), ES: num(pl.rate_es), EC: num(pl.rate_ec), FAM: num(pl.rate_fam) },
          monthly: num(pl.monthly),
        })),
      };
    },

    /** A group's own conversations, most recently active first. Staff trials are not among them. */
    async listThreads(groupName) {
      const { rows } = await pool.query(
        `SELECT id, title, created_at, updated_at FROM kennion.chat_threads
          WHERE group_name = $1 AND NOT staff ORDER BY updated_at DESC, id DESC LIMIT 200`,
        [groupName],
      );
      return rows.map(shapeThread);
    },

    async createThread(groupName, title, staff = false) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.chat_threads (group_name, title, staff) VALUES ($1, $2, $3)
         RETURNING id, title, created_at, updated_at, staff`,
        [groupName, title || null, !!staff],
      );
      return shapeThread(rows[0]);
    },

    /** One thread, only if it belongs to the group asking; a staff trial only when asked for. */
    async getThread(groupName, id, staff = false) {
      const { rows } = await pool.query(
        "SELECT id, title, created_at, updated_at, staff FROM kennion.chat_threads WHERE id = $1 AND group_name = $2 AND staff = $3",
        [id, groupName, !!staff],
      );
      return rows[0] ? shapeThread(rows[0]) : null;
    },

    /**
     * Every conversation across every group, for the admin: who asked, how
     * much, when, and the first question as a preview. Newest activity first.
     */
    async adminListThreads({ group, q, flagged, limit = 500 } = {}) {
      const where = ["true"];
      const vals = [];
      if (group) {
        vals.push(group);
        where.push(`t.group_name = $${vals.length}`);
      }
      if (q) {
        vals.push(`%${q}%`);
        where.push(`(t.title ILIKE $${vals.length} OR t.group_name ILIKE $${vals.length} OR EXISTS (SELECT 1 FROM kennion.chat_messages m WHERE m.thread_id = t.id AND m.content ILIKE $${vals.length}))`);
      }
      if (flagged) where.push("t.flagged_at IS NOT NULL");
      vals.push(limit);
      const { rows } = await pool.query(
        `SELECT t.id, t.group_name, t.title, t.staff, t.flagged_at, t.flag_note, t.created_at, t.updated_at,
                (SELECT count(*) FROM kennion.chat_messages m WHERE m.thread_id = t.id) AS n,
                (SELECT content FROM kennion.chat_messages m WHERE m.thread_id = t.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS preview
           FROM kennion.chat_threads t WHERE ${where.join(" AND ")}
          ORDER BY t.updated_at DESC, t.id DESC LIMIT $${vals.length}`,
        vals,
      );
      return rows.map(shapeThread);
    },

    /** One thread, any group, for the admin. */
    async adminThread(id) {
      const { rows } = await pool.query(
        "SELECT id, group_name, title, staff, flagged_at, flag_note, created_at, updated_at FROM kennion.chat_threads WHERE id = $1",
        [id],
      );
      return rows[0] ? shapeThread(rows[0]) : null;
    },

    async flagThread(id, flagged, note) {
      const { rows } = await pool.query(
        `UPDATE kennion.chat_threads SET flagged_at = $2, flag_note = $3 WHERE id = $1
         RETURNING id, group_name, title, staff, flagged_at, flag_note, created_at, updated_at`,
        [id, flagged ? new Date() : null, flagged ? note || null : null],
      );
      return rows[0] ? shapeThread(rows[0]) : null;
    },

    async adminDeleteThread(id) {
      const { rowCount } = await pool.query("DELETE FROM kennion.chat_threads WHERE id = $1", [id]);
      return rowCount > 0;
    },

    /** Keep a document the assistant made for a thread. Returns its record without the bytes. */
    async addFile(threadId, filename, mime, data) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.chat_files (thread_id, filename, mime, size, data, role) VALUES ($1, $2, $3, $4, $5, 'assistant')
         RETURNING id, filename, mime, size`,
        [threadId, filename, mime, data.length, data],
      );
      return { id: Number(rows[0].id), filename: rows[0].filename, mime: rows[0].mime, size: rows[0].size };
    },

    /** A client's attachment, held for the group until a message claims it. */
    async addPendingFile(groupName, filename, mime, data) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.chat_files (group_name, filename, mime, size, data, role) VALUES ($1, $2, $3, $4, $5, 'user')
         RETURNING id, filename, mime, size`,
        [groupName, filename, mime, data.length, data],
      );
      return { id: Number(rows[0].id), filename: rows[0].filename, mime: rows[0].mime, size: rows[0].size };
    },

    /** Attach the group's pending files to a thread. Only files it uploaded and has not yet sent count. */
    async claimFiles(ids, groupName, threadId) {
      if (!ids.length) return [];
      const { rows } = await pool.query(
        `UPDATE kennion.chat_files SET thread_id = $3 WHERE id = ANY($1::bigint[]) AND group_name = $2 AND thread_id IS NULL
         RETURNING id, filename, mime, size`,
        [ids, groupName, threadId],
      );
      return rows.map((r) => ({ id: Number(r.id), filename: r.filename, mime: r.mime, size: r.size }));
    },

    async sweepPendingFiles() {
      const { rowCount } = await pool.query("DELETE FROM kennion.chat_files WHERE thread_id IS NULL AND created_at < now() - interval '1 day'");
      return rowCount;
    },

    async listMemory(groupName) {
      const { rows } = await pool.query("SELECT id, text, source, created_at FROM kennion.client_memory WHERE group_name = $1 ORDER BY created_at, id", [groupName]);
      return rows.map((r) => ({ id: Number(r.id), text: r.text, source: r.source, createdAt: r.created_at }));
    },
    /** Add lines and drop the ids named; a line already there is not added twice. At most 40 kept. */
    async updateMemory(groupName, { add = [], removeIds = [], source = "client" } = {}) {
      if (removeIds.length) await pool.query("DELETE FROM kennion.client_memory WHERE group_name = $1 AND id = ANY($2::bigint[])", [groupName, removeIds]);
      for (const text of add) {
        await pool.query(
          "INSERT INTO kennion.client_memory (group_name, text, source) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM kennion.client_memory WHERE group_name = $1 AND lower(text) = lower($2))",
          [groupName, text, source],
        );
      }
      await pool.query("DELETE FROM kennion.client_memory WHERE group_name = $1 AND id NOT IN (SELECT id FROM kennion.client_memory WHERE group_name = $1 ORDER BY created_at DESC, id DESC LIMIT 40)", [groupName]);
      return this.listMemory(groupName);
    },

    async getFile(id) {
      const { rows } = await pool.query(
        `SELECT f.id, f.thread_id, f.filename, f.mime, f.size, f.data, f.role, COALESCE(t.group_name, f.group_name) AS group_name, COALESCE(t.staff, false) AS staff
           FROM kennion.chat_files f LEFT JOIN kennion.chat_threads t ON t.id = f.thread_id WHERE f.id = $1`,
        [id],
      );
      const r = rows[0];
      return r ? { id: Number(r.id), threadId: r.thread_id == null ? null : Number(r.thread_id), filename: r.filename, mime: r.mime, size: r.size, data: r.data, role: r.role, groupName: r.group_name, staff: !!r.staff } : null;
    },

    async renameThread(groupName, id, title) {
      const { rows } = await pool.query(
        `UPDATE kennion.chat_threads SET title = $3 WHERE id = $1 AND group_name = $2
         RETURNING id, title, created_at, updated_at`,
        [id, groupName, title],
      );
      return rows[0] ? shapeThread(rows[0]) : null;
    },

    async deleteThread(groupName, id) {
      const { rowCount } = await pool.query("DELETE FROM kennion.chat_threads WHERE id = $1 AND group_name = $2", [id, groupName]);
      return rowCount > 0;
    },

    async listMessages(threadId) {
      const { rows } = await pool.query(
        "SELECT id, role, content, page, files, created_at FROM kennion.chat_messages WHERE thread_id = $1 ORDER BY id",
        [threadId],
      );
      return rows.map(shapeMessage);
    },

    /** Append one turn and bump the thread so it sorts to the top. */
    async addMessage(threadId, role, content, page, files) {
      const { rows } = await pool.query(
        `INSERT INTO kennion.chat_messages (thread_id, role, content, page, files) VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, role, content, page, files, created_at`,
        [threadId, role, content, page || null, JSON.stringify(files || [])],
      );
      await pool.query("UPDATE kennion.chat_threads SET updated_at = now() WHERE id = $1", [threadId]);
      return shapeMessage(rows[0]);
    },

    /** Which carriers have a logo on file, with when. */
    async listCarrierLogos() {
      const { rows } = await pool.query("SELECT carrier, mime, updated_at FROM kennion.carrier_logos ORDER BY carrier");
      return rows.map((r) => ({ carrier: r.carrier, mime: r.mime, updatedAt: r.updated_at }));
    },
    async getCarrierLogo(carrier) {
      const { rows } = await pool.query("SELECT carrier, mime, data, updated_at FROM kennion.carrier_logos WHERE carrier = $1", [carrier]);
      return rows[0] ? { carrier: rows[0].carrier, mime: rows[0].mime, data: rows[0].data, updatedAt: rows[0].updated_at } : null;
    },
    async setCarrierLogo(carrier, mime, data, by) {
      await pool.query(
        `INSERT INTO kennion.carrier_logos (carrier, mime, data, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (carrier) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [carrier, mime, data, by || null],
      );
    },
    async deleteCarrierLogo(carrier) {
      const { rowCount } = await pool.query("DELETE FROM kennion.carrier_logos WHERE carrier = $1", [carrier]);
      return rowCount > 0;
    },

    async stats() {
      const g = await pool.query("SELECT count(*)::int n FROM kennion.groups");
      const o = await pool.query("SELECT count(*)::int n FROM kennion.rate_overrides");
      const q = await pool.query("SELECT count(*)::int n FROM kennion.carrier_quotes");
      return { groups: g.rows[0].n, overrides: o.rows[0].n, quotes: q.rows[0].n };
    },

    async close() {
      await pool.end();
    },
  };
}
