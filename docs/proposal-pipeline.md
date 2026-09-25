# BenSync proposal pipeline: how it works

This covers how carrier and TPA medical proposals (PDF or Excel) are loaded into
Railway Postgres, audited, and shown on each group's Medical Plans grid.

## 1. Principles

- **One unique carrier plan = one canonical record.** Each record has one
  BenSync ID (UH1, GR1…), one exact name, one plan code, one benefit set and
  one four-tier rate set (EE / ES / EC / FAM).
- **Every plan on a proposal is stored.** PPO and EPO alike. If the document
  has 100 unique plans, the database holds 100 and the count shows 100.
- **Canonical data is only what the proposal says.** Nothing is invented,
  inferred, renamed or borrowed into a canonical plan field. A blank stays
  blank (null), and screens show "Not stated". See section 1a.
- **Carrier-neutral.** Every carrier's plans are normalized into the same
  canonical plan record. Carrier-specific logic lives only in intake,
  parsing and extraction. Each proposal is its own source and audit boundary,
  and plans are never merged across proposals.
- **What a client sees is a separate layer.** Every Verified plan in each
  proposal slot that is ON for the group is shown. There is no auto-hiding
  by EPO, network or plan type. Turning a slot OFF hides its plans without
  deleting anything.
- **Nothing is green on one model's word.** "Verified" requires code checks
  plus two independent AI audits (Claude and OpenAI) of the exact version
  on the grid.
- **The AI repairs; people are asked only when it can't.** A server-side
  "steward" fixes failures on its own.

**Plan identity.** One definition is used everywhere: `identityKey()` in
`server/plan-canonical.js`, meaning the plan code when printed, otherwise the
exact printed name on its network. The plan count is the length of the
canonical list. Nothing downstream de-duplicates on name + rates.

## 1a. Data integrity: source, normalized, supplemental

The canonical plan in Postgres represents only what the Carrier/TPA
proposal states. Every value falls into one of these categories, and none
may overwrite another:

| Category | What | Where it lives |
|---|---|---|
| SOURCE | Exact name, plan code, network, plan type, deductible, OOP max, benefits and the four tier rates, as printed | `extracted.plans[]` |
| NORMALIZED | Deterministic, meaning-preserving forms of a source value: Gravie's `0.2` → `"20%"`, "$1,500" read as 1500 for sorting, HSA "yes"/"no" → true/false | The canonical field. The source cell is kept in `raw` where the form changes |
| SUPPLEMENTAL | A carrier's standard plan design: Kennion's plan catalogue (Angle, Optimyl) and Gravie's Benefits Grid | Served beside the plan under `design`, with a `source` label. Never written to the canonical plan |
| DERIVED | Network type (PPO/EPO/RBP) for filtering, monthly cost at the census, recommendations | Computed on read, never stored as a plan field |
| DISPLAY | Option label ("Angle Health Option AN1"), "Not stated", the "(standard design)" mark | Client only |
| SYSTEM / BUSINESS | BenSync ID, slot, verification, slot ON/OFF, funding by slot | Their own fields and tables |

Rules:

- **Proposal first.** A screen may show a supplemental value only where the
  proposal is blank. It is always marked "(standard design)" and names its
  source. Where the two disagree, the proposal wins and
  `design.disagreements` lists the difference.
- **Null is better than invented.** A missing network reads "Not stated". It
  is never filled with the network the carrier usually uses. The same goes
  for a missing plan type: it is never taken from the name. HSA eligibility
  counts only when the proposal states it.
- **The name is exact.** No "Surest" prefix or any other decoration is added
  to a stored or served plan name.
- **Audits and corrections use the proposal only.** Auditors compare stored
  proposal fields against the document. The corrector changes a value only
  to what the page prints; otherwise the plan goes to review.

## 2. Where the data lives

| Table / field | Holds |
|---|---|
| `kennion.proposals` | One row per proposal: the file bytes, `source_sha` (SHA-256 of the file), `slot` (carrier/TPA column), `group_name`, `stage` / `stage_reason` |
| `proposals.extracted.plans[]` | The canonical plans: `name`, `plan_code`, `network`, `plan_type`, `deductible`, `oop_max`, `benefits{}`, `rates{EE,ES,EC,FAM}`, `option_id`, `source{identity,benefits,rates pages / sheet,rows, appearances, codes}`, `conflicts[]` if appearances disagree |
| `proposals.extracted.reconciliation` | `plan_appearances → unique_plans (unique_ppo + unique_epo) → expected`, plus the reader's own counts |
| `proposals.extracted.corrections[]` | A log of every automated fix: field, old → new value, source page, reason, model, time |
| `proposals.audit` | Claude and OpenAI audit results, each tied to the reading `version` (hash of the stored values) and `sourceSha` |
| `proposals.extracted.plans[].raw` | Source cells kept before a normalization (Gravie: the coinsurance fraction, the sheet header's printed network, sheet and row) |
| `kennion.carrier_quotes` / `carrier_quote_plans` | Gravie workbooks, also stored as rows (one plan per row); `network` is the header's printed network |
| `kennion.proposal_slot_visibility` | Per group and slot: `client_enabled`, `updated_by`, `updated_at`. Kept apart from proposal data, so a re-read never changes it |
| `kennion.carrier_plan_designs` | The plan catalogue (supplemental standard designs), keyed by carrier, plan year and plan code |

The client grid, plan cards, documents and the AI Assistant all read the
same records: `currentProposals` → `clientAvailablePlans(group)`.

Every served plan has the same fields whatever the carrier:
- `optionId`, `identity`, `name` (exact), `planCode`, `network` (exact), `planType`
- `deductible`, `oopMax`, `benefits`, `rates` (EE/ES/EC/FAM)
- `source` (pages, or sheet and rows) and `raw`
- `design` (supplemental, labelled), when the plan is a known standard design

Each proposal also carries its `slot`, `carrier`, `funding` and `verified`.

## 3. The steps for each proposal

1. **Upload.** The file is stored with its SHA-256. Stage: `UPLOADED`.
2. **Extract** (`server/ai.js`, Claude Sonnet):
   - **PDFs over 20 pages are mapped first.** Each page is classified (plan
     identity, benefits, rates, boilerplate), and only the relevant pages are
     read. If that doesn't account for every plan, the whole document is read.
   - **Readings too long for one answer** are split in halves, down to single
     pages.
   - **Encrypted carrier PDFs** are read in page windows ("read only pages X–Y").
   - **Gravie Excel workbooks** use a deterministic code parser
     (`server/gravie-parse.js`) instead of AI. Both the PPO and EPO sheets are
     read.
3. **Canonicalize** (`server/plan-canonical.js`, pure code). Repeated
   appearances of a plan are merged by exact plan code, or by exact name on
   the same network. Similar names are never merged.
   - Merging adds page provenance, never another plan.
   - When two appearances disagree on a value, nothing is chosen silently:
     the disagreement is recorded as a `conflict`.
4. **Validate** (`server/plan-validate.js`, pure code, before any AI audit):
   - the reading is of the current file version;
   - **source coverage**: every PDF page was mapped or deep-read, every
     workbook sheet inspected, every CSV/text line and section read
     (`extracted.coverage`, recorded from what was actually read and tied
     to the file's SHA-256; part of the reading's version hash);
   - no duplicate canonical identities, no plan code on two plans, no exact
     printed name on two plans, no BenSync ID on two plans;
   - required fields are present;
   - all four tier rates are numeric;
   - every plan has source references;
   - no data comes from another plan's code;
   - there are no unresolved conflicts;
   - the counts reconcile.

   One printed name on two *different* plan codes is flagged for a person
   (`fix: "review"`), never merged or shown twice silently. The steward checks
   the names against the document once. If the document really prints one
   name for both, staff confirm it with the button in the NEEDS_REVIEW list
   (`POST /api/admin/proposals/:id/confirm-shared-names`).
5. **Dual audit** (`server/proposal-audit.js`). Claude and OpenAI each audit
   independently. For every stored plan, each returns what the document
   prints:
   - name, plan code, network;
   - deductible, out-of-pocket max, coinsurance;
   - PCP, specialist, imaging, urgent care, ER, hospital;
   - retail Rx by tier, HSA eligibility;
   - EE / ES / EC / FAM rates.

   The auditors get only what's needed to find each plan, never the stored
   values. Server code (`server/plan-compare.js`) compares each value with the
   database. Formatting is normalized for the comparison only ($1,500 = 1500);
   stored values are never rewritten.

   Each model's audit is two kinds of job:
   - **Document-level reconciliation** (once per model per version, the
     complete source): the plan count, stored plans not on the document,
     plans on the document not stored, a plan stored twice, a plan printed
     twice with different values, unreadable pages. This is the only job that
     reads the whole document.
   - **Plan field audits**, one per deterministic batch of 25 stored plans
     (every plan exactly once per model). Each reads a **targeted packet**
     (`server/audit-packets.js`), never the whole document again:
     - a PDF: only the pages the batch's plans are cited on (identity,
       benefit and rate pages, each once), plus page 1 and the page before
       each run of cited pages (continued table headers), original page
       numbers named in the instructions;
     - a Gravie (parser-read) workbook: only the batch's sheet(s), their
       header rows and the plans' own rows, each labelled with its Excel row
       number, cells as the workbook holds them (never the Benefits Grid);
     - an AI-read workbook: only the cited sheets, whole;
     - an AI-read CSV / text file, an image, an encrypted PDF, a plan with
       no provenance, or a packet that would be 80%+ of the document: the
       **full source**.
     If an auditor says a packet lacked context, or a plan in it cannot be
     found or confirmed, that batch is read again against the full source -
     never taken as a finding.
   - A proposal that fits in one batch runs both jobs as **one combined
     full-source call** per model.

   Every job is saved as it completes (`kennion.proposal_audit_jobs`), keyed
   to the exact source SHA, audit standard and the stored data it covers
   (the document job: the plans' identities and the coverage record; a
   batch: its plans' values and provenance). A retry, a restart, a deploy or
   a correction re-runs only jobs whose key no longer matches: a failed
   batch 4 re-runs batch 4; an OpenAI failure never re-runs Claude; a
   corrected rate re-runs that plan's batch (both models) and nothing else; a
   renamed, added or removed plan re-runs the document reconciliation too.
   A missing or failed job means Pending, never Verified. Each audit records
   `standard: 2`.
6. **Correct** (only when something fails). Claude reads a targeted packet
   of the plans the findings name (the same packet rules as the field
   audits; the whole document for anything structural - a missing, extra or
   duplicated plan, a count problem) and returns fixes with page references.
   - The fixes are applied and logged in `corrections[]`.
   - An "added" plan already stored under the same identity is not added
     twice.
   - The reconciliation is recomputed from the canonical list.
   - Validation runs again, then both models audit again.
7. **Grid check** (`server/proposal-verify.js`). Everything is compared by
   canonical identity:
   - the plans served for the group equal the stored plans, each with the
     same rates and BenSync ID;
   - the plans the client sees equal the stored plans the visibility rules
     leave in;
   - no carrier plan is served twice;
   - no BenSync ID is on two of the group's plans.
8. **Verified.** Stages run `UPLOADED → MAPPING → EXTRACTING → EXTRACTED →
   VALIDATING → AUDITING → (CORRECTING) → VERIFIED`, or `NEEDS_REVIEW` with a
   reason.

Admin (`/admin/proposals`):
- A Verified slot shows "✓ Verified · N plans". Hovering it shows
  Source ✓ · Extraction ✓ · Validation ✓ · Claude Audit ✓ · OpenAI Audit ✓ · Grid ✓,
  then "X appearances → Y unique (P PPO, E EPO) → N loaded → V shown to client".
- An empty slot is blank.

## 4. When it runs

- **One-time pass.** When a pipeline change requires it (a parser version or
  `STEWARD_EPOCH` bump), every stored proposal is brought up to the new
  standard once.
- **After that, only on change:**
  - **Proposal added:** read, validated, dual-audited.
  - **Proposal replaced** (new file in the same carrier slot): the new file
    is read. Once it has plans, the old row is deleted with everything read
    from it (plans, audits, correction log, Gravie quote rows), and its
    BenSync numbers are retired. If the new file fails to read, the old one
    stays in force.
  - **Proposal deleted:** the row and everything read from it is removed in
    one step. A startup sweep removes any quote rows left from files no longer
    on file.
- **A Verified proposal stays Verified.** The steward's periodic pass is code
  only (milliseconds). No AI call is made unless the file or its stored
  values change.
- **Repair limits per proposal:** 2 reads, 3 audits that could not complete,
  3 corrections per reading, then one fresh read and 3 more corrections. After
  that the slot shows `NEEDS_REVIEW` with the reason. An example is a slot
  holding a case summary instead of a quote.

So each group's database holds exactly the plans of the proposals currently
on file, and nothing else.

## 5. What the client sees

`clientAvailablePlans(group)` in `server/index.js` is the one resolver. It
feeds the grid, cards, comparison, pricing, documents, the AI Assistant and
plan selection.

- It returns every plan of every Verified proposal in a slot that is ON for
  the group. EPO, LocalPlus, HMO, any deductible or rate: these are
  attributes to filter and sort on, never reasons to hide a plan.
- The only control is the slot, per group: `POST /api/admin/proposal-slots
  { group, slot, clientEnabled }`, stored in
  `kennion.proposal_slot_visibility`. OFF shows none of the slot's plans;
  they stay stored, audited and Verified.
- `KENNION_CLIENT_VERIFIED_ONLY=0` also shows proposals that are not yet
  Verified (for rollout while the steward catches up).
- Plan-level exceptions (`server/plan-visibility.js`, `VISIBILITY_RULES`)
  are technically possible but empty, and are not a normal workflow.
- On the page, a plan's key (favorites, comparison, Sign Up) is its BenSync
  ID, never its name: two plans can share a name.

## 6. Admin endpoints

- `GET /api/admin/proposals/verify`: the full check for every group and slot.
- `POST /api/admin/proposals/fix`: wakes the steward now.
- `POST /api/admin/proposals/:id/confirm-shared-names`: a person confirms
  that the carrier prints one plan name for several plan codes.
- `DELETE /api/admin/proposals/:id`: removes a proposal and everything read
  from it.
- `GET /api/admin/proposals/:id/audit-progress`: which audit jobs are done
  and still valid, and the next one ("Claude batch 3 of 7").
- `GET /api/admin/ai-usage?proposal=ID` (or `?since=ISO`): every model call
  with its purpose, requested and served model, source sent, tokens (input,
  cache writes, cache reads, output), duration, retries and outcome, with
  totals by purpose and by model.

### API usage telemetry

Every model call is recorded in `kennion.ai_usage` (`server/ai-usage.js`):
proposal ID, group, slot, source SHA, reading version, audit standard,
purpose, provider, requested and served model, batch, plans in the batch,
the pages / sheets / rows / lines sent, input tokens, cache-write and
cache-read tokens, output tokens, an estimated cost where the model's price
is known, duration, retries, and success. Purposes:
- `extraction`, `source-map`
- `document-reconciliation-claude|openai`
- `document-and-field-audit-claude|openai` (a one-batch proposal)
- `plan-audit-claude|openai`, `fallback-full-read-claude|openai`
- `correction`
- `admin-explain-*` (the Opus write-ups on the Data Check pages)

Costs are left null for models with no built-in price; set
`KENNION_MODEL_PRICES` (JSON, per million tokens) to price them.

### Prompt caching

The auditor and correction system prompts, and every full-source block, are
cached with the 1-hour TTL (`cache_control: { type: "ephemeral", ttl: "1h" }`).
Packets are never cached, because each is read once. Cache entries are keyed
by the exact bytes, so a new file (a new source SHA) can never read an old
entry. `KENNION_SOURCE_CACHE_TTL=5m|off` changes the TTL if telemetry shows
full sources are mostly read once. A 1-hour write costs 2x input, so it
pays off only at three or more reads within the hour.

## 7. Models

- **Extraction, Claude audit and correction:** `claude-sonnet-5` (Anthropic
  SDK, streaming, structured JSON output). Extraction sends
  `fallbacks: "default"`: a read Sonnet's safety classifier declines is
  re-run server-side on Anthropic's fallback model (Claude Opus). The usage
  record and a log line name the model that actually served each read.
- **Second auditor:** OpenAI `gpt-5`.
- The UI says "Verified" / "Dual Audit Passed", never "100% accurate". Two
  independent audits sharply reduce the risk of an error; they are not a
  mathematical guarantee.

## 8. Tests

The main tests for this pipeline, in `scripts/`:

- `test-plan-canonical.mjs`
- `test-proposal-verify.mts`
- `test-split-read.mjs`
- `test-gravie-parse.mjs`
- `test-option-ids.mjs`
- `test-proposal-delete.mjs`
- `test-proposal-audit.mjs`
- `test-field-audit.mjs` (field-by-field comparison, batching)
- `test-audit-cost.mjs` (one document reconciliation per model, targeted packets, every plan once per model, resumable and versioned jobs, full-source fallback, 1h cache, telemetry)
- `test-schema-limits.mjs` (every schema sent to Anthropic within 16 union-typed parameters)
- `node scripts/audit-cost-estimate.mjs [--db]`: source pages sent before and after, for representative or real proposals
- `test-shared-names.mjs` (one name on two codes: flag, review, confirm)
- `test-option-ids-reread.mjs`
- `test-source-coverage.mjs` (CSV sections, workbook sheets, truncation, Gravie sheets, the coverage check)
- `test-client-plans.mts` (100 quoted = 100 stored = 100 audited = 100 on the grid; slot OFF shows 0; the common plan record)
- `test-plan-catalogue.mjs` (catalogue as a separate standard-design layer; the proposal wins; disagreements listed)
- `test-market-plans.mts` (proposal values first, standard design only in gaps and marked, "Not stated", no invented network or type)
