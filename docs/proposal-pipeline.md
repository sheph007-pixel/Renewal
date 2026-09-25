# BenSync proposal pipeline: how it works

This covers how carrier and TPA medical proposals (PDF or Excel) are loaded into
Railway Postgres, audited, and shown on each group's Medical Plans grid.

## 1. Principles

- **One unique carrier plan = one canonical record.** Each record has one
  BenSync ID (UH1, GR1…), one exact name, one plan code, one benefit set and
  one four-tier rate set (EE / ES / EC / FAM).
- **Every plan on a proposal is stored.** PPO and EPO alike. If the document
  has 100 unique plans, the database holds 100 and the count shows 100.
- **What a client sees is a separate layer.** Rules can hide stored plans
  from the client; nothing is deleted to hide it.
- **Nothing is green on one model's word.** "Verified" requires code checks
  plus two independent AI audits (Claude and OpenAI) of the exact version
  on the grid.
- **The AI repairs; people are asked only when it can't.** A server-side
  "steward" fixes failures on its own.

## 2. Where the data lives

| Table / field | Holds |
|---|---|
| `kennion.proposals` | One row per proposal: the file bytes, `source_sha` (SHA-256 of the file), `slot` (carrier/TPA column), `group_name`, `stage` / `stage_reason` |
| `proposals.extracted.plans[]` | The canonical plans: `name`, `plan_code`, `network`, `plan_type`, `deductible`, `oop_max`, `benefits{}`, `rates{EE,ES,EC,FAM}`, `option_id`, `source{identity,benefits,rates pages / sheet,rows, appearances, codes}`, `conflicts[]` if appearances disagree |
| `proposals.extracted.reconciliation` | `plan_appearances → unique_plans (unique_ppo + unique_epo) → expected`, plus the reader's own counts |
| `proposals.extracted.corrections[]` | A log of every automated fix: field, old → new value, source page, reason, model, time |
| `proposals.audit` | Claude and OpenAI audit results, each tied to the reading `version` (hash of the stored values) and `sourceSha` |
| `kennion.carrier_quotes` / `carrier_quote_plans` | Gravie workbooks, also stored as rows (one plan per row) |

The client grid, plan cards, documents and the AI Assistant all read the
same records: `currentProposals` → `clientProposals`.

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
   - no duplicate plans, codes or BenSync IDs;
   - required fields are present;
   - all four tier rates are numeric;
   - every plan has source references;
   - no data comes from another plan's code;
   - there are no unresolved conflicts;
   - the counts reconcile.
5. **Dual audit** (`server/proposal-audit.js`). Claude and OpenAI each audit
   the document against the stored plans, independently.
   - Each must report the plan count and read all four rates of every plan
     off the page.
   - The server compares the rates to the database in code.
   - Each audit is tied to the exact reading version and file hash.
6. **Correct** (only when something fails). Claude re-reads just the pages
   involved and returns fixes with page references.
   - The fixes are applied and logged in `corrections[]`.
   - Validation runs again, then both models audit again. The corrector never
     settles a finding on its own word.
7. **Grid check** (`server/proposal-verify.js`). The plans served for the
   group must equal the stored plans, and the plans the client sees must
   equal the stored plans the visibility rules leave in.
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

## 5. What the client sees (visibility layer)

`server/plan-visibility.js`:

```js
export const VISIBILITY_RULES = [
  { key: "epo", reason: "EPO - Kennion offers PPO plans only", hides: (pl) => isEpoPlan(pl) },
];
```

- A plan that any rule hides stays in the database and is marked `hidden`.
- It is left out of the client grid, plan cards, printed documents and the
  AI Assistant.
- BenSync IDs are given to shown plans first, so the client's numbers run
  without gaps. Hidden plans are numbered after them.
- To add per-group or per-carrier show/exclude choices later, add a rule to
  this list (it receives the group). Extraction, storage and the audit are
  unaffected.

## 6. Admin endpoints

- `GET /api/admin/proposals/verify`: the full check for every group and slot.
- `POST /api/admin/proposals/fix`: wakes the steward now.
- `DELETE /api/admin/proposals/:id`: removes a proposal and everything read
  from it.

## 7. Models

- **Extraction, Claude audit and correction:** `claude-sonnet-5` (Anthropic
  SDK, streaming, structured JSON output).
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
