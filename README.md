# Kennion 2027 Renewal Portal

A group-facing renewal portal for Kennion Benefit Advisors. A group signs in
with its access code and sees two things:

1. **Current Medical Plan(s)** — the plans in force for the 2026 plan year,
   with 4-tier composite rates, enrollment by tier, and total monthly employer
   cost / employee cost / premium per plan. An **Employee Cost Breakdown** opens
   named employee detail with ages, tier and per-person EE/ER/total, switchable
   between monthly, semi-monthly, bi-weekly and weekly.
2. **2027 Medical Plan Options** — the shopped market (UnitedHealthcare Level
   Funded, Gravie, Nationwide, Angle), every plan costed at the group's own census,
   as one grid of every plan from every carrier, lowest cost first. Above it,
   **Employer Contribution**: four monthly figures by tier and Apply, which
   drive an Employer Cost column (contribution × enrolled per tier, never more
   than the premium). Filter tabs — Carrier, Network Type (PPO, EPO or RBP, read off the proposal), Deductible and OOP Max by range,
   Funding, Total Cost ($ to $$$$, sorted either way) — and a search; each row
   is carrier, plan, deductible, OOP max, employer cost and total monthly, and
   clicking it opens a plan card: total monthly cost, benefits, composite
   rates with the enrolled count per tier and the employer / employee split,
   then the totals. A heart shortlists a plan (the shortlist Sign Up sends);
   + adds it to a proposal of those same cards that downloads as Excel or
   prints to PDF. Gravie's benefits come from its static Benefits Grid, by
   plan family; UnitedHealthcare's from its menu.

Both sections print to a clean report, and every page carries the carrier
disclaimer footer — including in print.

## Pages and addresses

The portal lives at **https://app.kennion.com**. Every page has its own address,
so the browser's back and forward buttons work, a page can be bookmarked or sent
as a link, and a reload comes back to the same place.

| Address | Page |
| --- | --- |
| `/` | Group sign-in |
| `/<group-slug>` | A signed-in group's Welcome page — `/johnson-storage-moving-jsmh2027` |
| `/<group-slug>/<tab>` | …its other pages: `assistant`, `current`, `options`, `supplemental`, `signup` (`changes`, an old address, lands on Welcome, where What's New for 2027 is a section now) |
| `/<group-slug>/assistant/<id>` | One conversation with the assistant |
| | The rail lists **Medical Plans** once and opens it on the 2027 options; the page has two tabs, *New 2027 Medical Options* (`options`, leading, marked NEW) and *Current 2026 Medical Plans* (`current`, muted, for reference), to switch between. |
| `/g/<group-slug>/<token>` | A group's permanent link: signs the browser in and lands on `/<group-slug>` |
| `/current` | Current Medical Plan(s) — the second tab of **Medical Plans** |
| `/options` | 2027 Medical Plan Options — the first tab of **Medical Plans**, where the rail lands |
| `/admin` | Staff sign-in |
| `/admin/groups` | Rate Administration — Groups |
| `/admin/groups/<company name>` | One company's page |
| `/admin/rates` | Rate Administration — Plans & Rates |
| `/admin/import` | Rate Administration — Import |
| `/admin/assistant` | Rate Administration — Assistant: conversations, playbook, try it as a group |
| `/admin/data` | Rate Administration — Data Check: every group's figures checked, and what the assistant is told |
| `/admin/welcome` | Rate Administration — Welcome Page: the Welcome page copy every group reads (one set for Existing, one for New), and the name and effective date each group is shown |

Sections within a page are `#hash` anchors — `/options#shortlist`, say — and
each group page lists its sections under the heading as "On this page" links.
The company page carries a breadcrumb back to the Groups list and a link into
Plans & Rates filtered to that company.

Opening an address without a session shows the matching sign-in form (the
staff one for anything under `/admin`) and lands on that page afterwards. The
session is kept in the tab's `sessionStorage` — the group's own access code, or
the staff token, never any census data — so it survives a reload and ends when
the tab closes. A group at a staff address, or staff at a group address, is
sent to its own home page. The server answers every non-API path with the app,
so deep links work on a fresh load.

Kennion staff reach **Rate Administration** through the small "Admin" link under
the sign-in card, with an email and code. It has three tabs: **Groups** (the
roster, access codes, addresses and ALE buckets), **Plans & Rates** (every
group × plan × tier rate), and **Import** (upload an export, with the history of
what came in when).

Clicking a company name opens its own page: access code, ALE bucket, every
company detail as an editable field, contacts, plans in force, and where the
data came from. Edits are stored separately from the imported payload and
override it, so a correction is not undone by the next export. The company name
is deliberately **not** editable — it is the key an import matches on, so
renaming would orphan the group.

The **Welcome Page** tab holds the words on every group's Welcome page,
written once: one set for Existing groups and one for New, with the same
fields (headline, intro, the four How It Works steps, the closing section, the
team card's note and the page footer). Saving pushes it to every group of that
status on its next page load. Below it, each group's **name and effective date
shown** can be reworded for its own pages without touching the official
company name (what imports match on) or the effective date Sign Up and the
PDFs use.

A group can be **archived**: it drops out of the list and its access code is
refused at sign-in, but nothing is deleted and it can be restored at any time.

### The Welcome page

Welcome is written for an existing Kennion client, not a prospect: the
program is expanding for 2027, BenSync makes the options easier to evaluate,
the client chooses what to offer, and Kennion handles the implementation
after that. Its header is the group's name alone. It has four parts: The 2027 Kennion
Program story first (`ProgramStory.tsx`: six frames from the program deck
that advance on their own, pause on hover and under reduced motion, every
tile the same size), a short introduction with the 2027 Program Overview
download under it, a four-step How It Works (Review Medical
Options, Review Supplemental Benefits, Build Your Strategy, Sign Up) with We
Handle The Rest under it, and one Your Kennion Team card. The card
(`TeamCard.tsx`) has a navy band and three members: the account manager,
the licensed broker (`broker` in `server/data/account-managers.json`, sent in
the group payload, with Hunter as the client's fallback) and the BenSync AI
Assistant, whose Ask The AI Assistant button opens the corner chat box (the
member is absent when the server cannot answer). Scheduling a call is never
the page's call to action; the work happens in BenSync, and the card is
there for questions along the way.

"Download 2027 Program Overview" builds the group's own 2026-to-2027 summary
on the server each time it is pressed (`POST /api/group/export` with
`format: "changes"`, `renderChangesReport` in `server/documents.js`,
`exportChangesPdf` in `client/src/lib/chat.ts`): the expansion of the
program, stat tiles, the plans in force today with their premiums, every
priced 2027 option by carrier lineup with its Employee Only rate, monthly
total at the group's enrollment and the difference against today, what the
numbers come to for this group, where the market review stands, what stays
the same, the four next steps (with the date of any Sign Up already sent)
and the team. It uses the same rules as the Medical Plans page (`optionRows`
mirrors `proposalPlans`: priced at every enrolled tier, no duplicates, no
Cobalt) and the same rates footer as every other document.

Headings and calls to action read in Title Case site-wide, every word
capitalised: the strings are written that way, `styles.css` holds `h1`-`h3`,
`button` and `.cta` to it with `text-transform: capitalize`, and the heading
scale lives in one place (`h1`, `h2`, `h3`, `kicker` and `ctaLink` in
`client/src/lib/ui.ts`) so a page title, a section heading, a sub-head and
a small uppercase label look the same on every page.

What's New For 2027, under it, says how many priced medical options the
group has and where the market review stands. `marketReview` in
`client/src/lib/model.ts` counts the group's proposal slots (the program's
five, less Cobalt): the review is complete once every slot holds a priced
plan, and in progress while any is still empty, in which case the page says
more options may still be added. A carrier that declines to quote leaves
its slot empty, so such a group reads as in progress until that slot is
filled or removed from the group's slots. No carrier names, networks or
figures appear on Welcome; those belong on Medical Plans. The subline under
the page title names the renewal year, the year after the plan year in
force. `scripts/test-market-review.mts` covers the rule.

## Access codes and group size

A group's code is four letters from its company name plus the plan year —
`JSMH2027` for Johnson Storage & Moving Co. Holdings. Four or more significant
words give their initials; shorter names use the first four letters run
together (`DAHL2027`), and legal-form words like "LLC", "Inc." and "Holdings"
never take a slot. Clashes replace the last letter with a digit, so every code
stays eight characters — Certicable is `CERT2027`, Certified Alarm `CER22027`.

Codes are derived over the whole roster so they are collision-free, and any of
them can be typed over in the Groups table; a hand-assigned code wins and is
checked for uniqueness. Codes from the previous `KEN-XXXX-9999` scheme are still
accepted, so anything already sent out keeps working.

Every group also has a **permanent link** of its own:
`https://app.kennion.com/g/johnson-storage-moving-jsmh2027/3EzxfXfLz9HWv59zqNklMQ`.
The token is 22 random characters, minted once and kept in
`group_meta.link_token`, so it survives deploys and imports and cannot be
guessed from a company name the way a code can. Opening the link signs the
browser in with no code to type, and signing in — by link or by code — sets a
**session cookie**: the token signed with a secret kept in `kennion.settings`,
HttpOnly and SameSite so no script reads it and no other site sends it, good
for thirty days, and dead the moment a new link is minted.

With the session in a cookie, a group's everyday address is short — the
company and its plan-year code, then the tab: `/johnson-storage-moving-jsmh2027`,
`/johnson-storage-moving-jsmh2027/options`. Nothing secret rides in the bar,
so the address can be bookmarked, reloaded, pasted in a screenshot or read out
over the phone, and a permanent link is rewritten to it as soon as it has done
its work. A short address with no session behind it shows the sign-in form and
lands there afterwards; a cookie for one group does not open another group's
address. The slug is `groupSlug()` in `client/src/lib/router.ts` and
`server/slug.js`, the same function on both sides, and it ends in the group's
code so every slug is unique.

Every company page shows the link with a Copy button and a **New link** button
that mints a fresh token and kills the old one, every row in the Groups table
has a **view as client** link, and the CSV export carries a Client link column.
An archived group's link is refused, as its code is. `/?code=XXXX` still works
and redirects to the group's short address.

**What a group's link reaches.** Its own pages, and nothing else. The census
never leaves the server: a group's payload carries enrolled counts by tier —
overall and per plan — and no employee record, so no name, age, ZIP, gender or
dependant's age is ever sent to a browser. The Employee Cost Breakdown reads by
tier rather than by person, with the same totals. Neither does any other
company travel in it: the 2027 market data is trimmed to the carrier menu, the
plan mapping and this group's own quoted rows, and the one cross-group number
the pricing needs — an average employee rate used to scale a group UHC has not
underwritten — is reduced to a single number. `scripts/test-group-payload.mjs`
holds the line: it signs in as a group and asserts no member field and no other
company's name appears anywhere in the payload, and that a group's credentials
are refused by every admin route.

**Kennion's own bookkeeping stays on the admin side.** The fields a client's
pages receive are an allow-list, not a deny-list — name, code, link token, TPA,
enrolled, lives, tier counts, premium, plans, rates and the plan year — so a
field added to a group later is not shipped to a client until someone puts it
on that list on purpose. Broker, account manager, renewal state, SIC and
division codes, and the archived and eligibility flags never leave the admin
side.

**Guessing is throttled.** A code is four letters from the company name plus
the plan year, so it is guessable by anyone holding the client list. Ten failed
sign-ins from one caller in ten minutes and that caller is cut off with a 429,
a real code included, until the window passes; a success clears the count and
another caller is unaffected. The same counter covers staff sign-in.

**Every response carries the ordinary defences**: `Referrer-Policy: no-referrer`
so a group's token never rides a Referer header off the site,
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a cross-origin
opener policy, a permissions policy, HSTS once TLS is on, and `no-store` on
every API response so nothing signed-in sits in a shared cache.

Even so the link is the credential for that company's own rates and
enrollment, so it is for sending to the client rather than posting publicly. If
one leaks, press **New link**.

Each group is also categorised **2-50** or **51+ (ALE)**. It defaults from
enrolled headcount and can be set explicitly, since ALE status is a legal
determination rather than something an enrollment count settles.

Every group also carries a **Broker** label: **Kennion**, for groups Kennion
places directly, or **Outside Broker**. Seven groups ship labelled Outside
Broker; the label can be flipped on any group in the Groups table or on its
page, and the Groups table sorts and filters on it. Only the label is stored —
never the outside broker's name.

Each group also has a **2027 renewal** state for tracking — **Open** (the
default), **Sent**, **Renewed** or **Non-Renewed** — set from the Groups table
or the company page and saved like the other labels.

The Groups page opens with a dashboard that follows the filters: group count,
enrolled employees and covered lives, and two premium figures for whatever is
on screen — filter to a broker, a size band or a renewal state and the numbers
describe that slice, with its share of the whole block. The two premiums are
deliberately different things:

- **Group health premium** is medical premium on **EBPA and HealthEZ only** —
  the captive program Kennion earns on. A group's BCBS of Alabama medical is in
  the portal but is *not* in this number.
- **Total premium** is every active enrollment on every line: all medical (BCBS
  included) plus dental, vision, life, disability and anything else in the
  Employee Navigator export.

Both count the same people the enrolled figure does — active employees with an
open enrollment — and never a terminated or waived one. The shipped census
carries medical only, so a group's supplemental lines (and therefore the gap
between its medical and its total) appear once its Employee Navigator export
has been imported again; until then the Total tile says so, and the CSV's
"Supplemental loaded" column reads No. The renewal
tile counts each state within the current slice; click one to filter to it. The table below keeps to eight
columns — company and access code, location, contact, enrolled, **% of block**
(that group's enrolled employees as a share of every enrolled employee in the
portal, so concentration is visible at a glance), size, broker, renewal — with
the rest of each group's details on its own page. A totals row at the foot adds
up whatever is on screen and moves with every search, filter and sort, so
filtering to Outside Broker shows what share of the block those groups hold. The **Export** button downloads exactly those rows as a CSV that opens
in Excel, with every detail column included. Filter first, then export, and the
file is the report.

Enrollment is counted the same way everywhere: a group's enrolled figure on the
Groups page is the sum of the enrolled counts of its plans on Plans & Rates,
and both pages apply the same roster rule, so their group counts agree.

A company's page shows its medical **Plans in force** and, beneath them,
**Other lines in force** — each dental, vision, life or disability plan with
its carrier, enrolled count and monthly premium, and a one-line summary of
group health / medical / supplemental / total. Only totals are kept for these
lines; the portal never prices them.

## Who is in the portal

The 2027 program covers **EBPA, HealthEZ and BCBS of Alabama**. A group is in
the portal only if it has at least one medical plan from one of those with
someone actually enrolled — a plan on the books with nobody on it does not
count. Anything else is refused at sign-in.

Carrier names arrive as free text from the Employee Navigator plan catalog, so
matching is tolerant: EBPA, HealthEZ in any spacing, and Blue Cross / Blue
Shield / BCBS / the Alabama "Blue Secure" and "Blue Choice" product families,
matched against the plan's TPA *and* its name.

One roster rule applies across the whole admin: a group that is archived, or
not on a program carrier, is not in the portal and is not rate-administered
either. It is excluded from Plans & Rates, from the group counts, and from the
rates export, so the tabs cannot disagree about how many groups there are.

An unmatched group is never silently dropped. It stays in Rate Administration
behind a **"Not in program"** filter, listing the carriers actually found on it,
so a program carrier under an unrecognised name is visible and can be added to
the rule. The same picker holds **"All groups"**, which shows every company on
file — live, archived and not in program together, each marked — for when you
want the whole book rather than the block the portal serves.

## Proposals

### PPO only

A fixed rule: **an EPO plan is never stored, numbered or shown.** Kennion
offers PPO plans only. UnitedHealthcare's menu carries an
E-coded EPO twin of most P-coded PPO plans, and Gravie prices every design
twice, EPO and PPO; the EPO sits a few dollars under the PPO and adds a choice
without adding a decision. So an EPO plan never makes it into the portal:
the Gravie parser reads the PPO sheet only, a Claude reading of a carrier
PDF is stripped of its EPO plans before it is stored, a stored reading from
before this rule is cleaned at boot (and its Gravie workbook re-read), the
UHC menu drops its E-coded plans, and a current plan the UHC mapping had
pointed at an EPO is mapped to its PPO twin (same deductible, out-of-pocket
max and coinsurance) so the like-for-like comparison still holds. The same
for every group; what is stored is what the carrier quoted for the plans
Kennion offers, name and rates as printed. The switch that once turned the
rule off is gone (`POST /api/admin/market-rules` accepts `ppo-only` and
nothing else), and the client itself drops any EPO row that reaches it.

Cobalt is not offered as a 2027 option: its slot is not shown on any group,
its proposals are not served to clients, and the assistant does not name it.
Anything already uploaded stays stored.

### One carrier, one funding type

A group's 2027 plans all come from one carrier, and with UnitedHealthcare
all fully insured or all level funded — never Gravie beside UnitedHealthcare,
never UHC fully insured beside UHC level funded. The grid's ♡ shortlist
(what Sign Up sends) holds to it: the first favorite sets the carrier and
funding, and a plan that does not fit cannot be added until the shortlist
is cleared; Sign Up refuses a mixed shortlist and so does the server
(`signupMix` in `server/index.js`, 400); the assistant's system prompt
carries the rule for its recommendations. Comparing across carriers (the
grid's + column, the assistant's side-by-sides) stays open — choosing is
what the rule is about. The Funding filter (Level Funded / Fully Insured)
sits after Network Type.

### Option IDs

Every quoted 2027 plan carries a short, stable handle — **UH3**, **GR1** —
so a client, Kennion and the assistant can point at one plan among dozens
without the carrier's full name. The prefix is the carrier (UH
UnitedHealthcare, with fully insured and level funded numbered together; GR
Gravie; NW Nationwide; AN Angle); the number runs per group in the order the
carrier lists its plans. `assignOptionIds` in `server/index.js`, run from
`proposalsChanged`, writes `option_id` into each stored plan; a number is
never reused. A re-read of a proposal, or a newer proposal in the same
slot, hands each surviving plan its old number (matched by plan code, then
by exact name) and gives new plans the next free ones. Only offered plans
are numbered: Kennion offers PPO plans only, and an EPO twin is never
stored, so Gravie's 67 designs read GR1–GR67 for every group, not GR1–GR134
with every other number missing. A reading stored before that rule is
cleaned of its EPO twins and renumbered once, compactly, at boot; a group
holding a number twice (the two UnitedHealthcare slots once restarted at
UH1 separately) is repaired the same way. Only proposals are numbered:
for one day the seed's UHC menu was numbered too and a proposal plan that
was a menu plan took the menu's number, so a group listed in the leftover
`optionIds.menu` setting has its UH sequence renumbered once, compactly,
in proposal order, and the setting is cleared. The ID is the first column of the grid (sortable,
searchable, first column of the CSV), a badge on the plan card and the
printed proposal, part of the Sign Up shortlist ("UH3 · P4000i8021B"), the
first thing the assistant says about a plan, and what `create_comparison`
accepts. Test: `node scripts/test-option-ids.mjs`.

### Proposal audit

Every proposal's stored reading is checked against the document itself by
two models from two different companies before a client is shown it
(`server/proposal-audit.js`): Claude Sonnet 5 and ChatGPT, independently.
Each auditor must count the plans on the document - every option found, the
EPO plans left out on purpose (Kennion offers PPO only), and the plans that
remain ("16 found, 2 EPO excluded, 14 expected") - read all four tier rates
off the page for **every** stored plan (the server compares them to the
database in code, so a rate an auditor did not happen to notice is still
checked), and report every other value the document contradicts. The audit
**passes** only when both models ran, both confirmed every plan's rates,
both counts equal the database, and neither has a finding; any finding makes
it **issues**; a model that is off, failed or skipped a plan leaves it
**pending** - never a pass on one model's word. Each audit records the exact
reading it checked (`version`, a hash of the stored plans), so a correction,
a re-read or a newer upload makes it stale on its own, and a client's plan
card only ever shows a current pass ("✓ Proposal Audit Completed"); anything
else reads "under review by Kennion". ChatGPT is called with a 20-minute
timeout and one retry, since a large PDF can take longer than Node's fetch
waits.

### One carrier plan, one canonical record

The carrier's proposal is the source of truth, and every plan on it becomes
exactly one canonical record: one BenSync ID (UH3, GR12 - stable, never
reused), the exact printed plan name and plan code, one set of benefits and
one four-tier rate set, all belonging to that plan. The record lives in
Postgres on the proposal's row (`kennion.proposals.extracted.plans`), and
everything reads it: the admin grid, the client's Medical Plans grid and
plan cards, comparisons, the shortlist, contribution and cost figures, the
generated documents and the AI Assistant (`currentProposals` →
`clientProposals`). There is no second copy of a plan anywhere the client or
the assistant sees. (`kennion.carrier_quote_plans` is an admin-only export of
the Gravie rows, for the quotes endpoint.)

**Identity and deduplication** (`server/plan-canonical.js`). A proposal
shows one plan many times - overview, comparison table, benefit page, rate
page, appendix. Each is an *appearance*; the reader returns them with the
pages each came from, and they are folded by exact identity: the carrier's
plan code (case and spacing aside), or - only when no code is printed - the
exact printed name on the same network. An appearance with no code joins a
coded plan only when exactly one coded plan carries that exact name. Two
different codes are never one plan; similar names are never merged; names
and codes are stored exactly as printed (whitespace aside), never shortened
or normalised. Repeated appearances add their pages to the plan's
provenance, never another plan. When two appearances of one plan disagree on
a material value (a rate, the deductible, a copay, the network), nothing is
chosen silently: the first value is kept, the disagreement is recorded on
the plan (`conflicts`, with each value's pages), and validation fails until
the correction step has read the plan's own table and settled it.

**EPO exclusion** stays - Kennion offers PPO plans only - but EPO plans are
listed, not dropped: `extracted.excluded` names each with its code, pages
and reason, and `extracted.reconciliation` counts it all:
`plan_appearances → unique_plans (unique_ppo + unique_epo) → excluded →
expected`, alongside the reader's own unique count. Both auditors are given
the exclusions, so an EPO plan is never taken for a missing one.

**Provenance.** Every canonical plan carries `source`: the pages its
identity, benefits and rates were read from (original page numbers, even when
it was read from an excerpt), or for a workbook the sheet and rows; the number
of appearances; and every plan code seen on them.

**Reading long PDFs** (`server/ai.js`). A PDF over 20 pages is first
*mapped*: Claude marks every page as plan identities, benefit summary or
detail, rates, ancillary or boilerplate, and estimates the PPO and EPO plan
counts. The map only steers; it is never plan data. The medical pages (and
any page the map skipped) are read as excerpts of at most 40 pages, and the
excerpts' appearances are merged by exact identity - a plan whose benefits
are on page 18 and rates on page 37 is one plan with both. If that cannot
account for every plan (a plan with benefits but no rates, fewer plans than
the map saw), the whole document is read instead. Any reading too long for
one answer is halved down to single pages and folded the same way, so no
plan near either end is lost to an output limit. Carriers often send
owner-password-encrypted PDFs, which open without a password but which
pdf-parse cannot read and pdf-lib will not cut: their pages are counted
with pdf-lib (encryption ignored, or the map's count), and each half is
read by sending the whole document with "read only pages X-Y" - the way
Boss Logistics', Adobe HVAC's and Taz Panama City's UHC Level Funded quotes
now read (`STEWARD_EPOCH` gave them a fresh round of repairs). Spreadsheets and CSVs are
read as text by sheet, with sheet and row provenance; text cut at the
300,000-character limit is flagged, never silently short. Gravie workbooks
keep their code parser, which now records each plan's sheet and row.

**Deterministic validation** (`server/plan-validate.js`) runs before either
AI audit: the reading is of the document version on file; no duplicate
plans, plan codes, names or BenSync IDs (within the group too); name,
deductible and out-of-pocket max present; four numeric tier rates (or a tier
the document is confirmed not to price); source references for identity,
benefits and rates; no plan holding data from another plan code; no
unresolved conflicting appearances; and the counts reconcile - expected
equals stored, PPO plus EPO equals unique, the reader's unique count equals
what was stored. No count, uniqueness or version check is left to a model.

**Versions and stale results.** Each proposal row keeps `source_sha`, the
SHA-256 of the document as uploaded. Each reading records the hash it was
extracted from; each audit records both that hash and a hash of the exact
stored values (`version`). An extraction, audit or correction that finishes
after the document or the reading has changed is discarded, never written,
and an audit of an earlier version never counts. A newer upload replaces the
proposal in force only once it has read successfully.

**Processing states.** `kennion.proposals.stage` is one of UPLOADED,
MAPPING, EXTRACTING, EXTRACTED, VALIDATING, AUDITING, CORRECTING, VERIFIED
or NEEDS_REVIEW (`stage_reason` says why). Only a proposal the whole check
calls Verified is shown to the client, its plan cards and the assistant as
checked ("✓ Verified · Dual Audit Passed"); anything else reads as being
reviewed by Kennion.

### Verified: the check, and the AI that works it

Every slot with a proposal in it is held to one standard
(`server/proposal-verify.js`); an empty slot is just blank. A box is
**Verified** - green, "✓ Verified · 14 plans" - only when all of these hold:
**Source** (the original document is on file and its version hash recorded),
**Extraction** (the read finished: plans, each named and rated),
**Validation** (every deterministic check above passes), **Claude Audit**
and **OpenAI Audit** (each passed, independently, of this exact reading of
this exact document, confirming every plan's name, code, benefits and four
rates, with its plan count equal to the database's), and **Grid** (the
group's Medical Plans grid shows exactly the stored plans - document,
database and grid, one number). Hovering the box shows "Source ✓ ·
Extraction ✓ · Validation ✓ · Claude Audit ✓ · OpenAI Audit ✓ · Grid ✓",
the reconciliation ("31 appearances → 19 unique (16 PPO, 3 EPO excluded) →
16 expected · database 16 · grid 16"), the excluded plans, each validation
check and each step's detail. The one plan the grid may leave out is one
the carrier's document does not price for a tier the group has people in,
confirmed against the page. Two independent AI audits sharply cut the risk
of an error; they are not a mathematical guarantee, and the page says
"Verified" / "Dual Audit Passed", nothing stronger.

Nobody fixes a box by hand. A server-side **steward** works the check on
its own - at boot, after every change to the proposals, and every ten
minutes, group by group - and carries out the repair each failing box
names: read the document again (in parts when long), run the dual audit,
or **correct** it: Claude is given the stored plans with their pages, both
auditors' findings, the validation failures, any conflicting appearances and
the missing tier rates - and, when every finding is about a value on a plan
whose pages are known, only those pages of the document (a missing,
duplicated or extra plan, or a count problem, gets the whole document). It
reads each value off the plan's own table rather than taking an auditor's
proposed value, and returns the fixed values (with the page it read each
from and why), the plans the database is missing (added in full, with their
pages), the tier rates it lacks, and anything not on the document (removed);
the server applies them (`applyCorrection`) and logs every change on the row
(`extracted.corrections`: proposal, reading version, BenSync ID, exact plan
name, plan code, field, previous and corrected value, source page, reason,
model, time). Deterministic validation then runs again, and only a reading
that passes it goes back to both auditors. A correction is always followed by a fresh audit
by both models - the corrector never settles a finding on its own word.
Limits per proposal: two reads, three audits that could not complete, three
corrections per reading and then one fresh read and three more. Only a box
still failing after all of that - a slot holding a case summary instead of a
quote, say - is shown as needing a person, with the reason; "let the AI try
these again" gives those another round. `GET /api/admin/proposals/verify`
returns the check; `POST /api/admin/proposals/fix` wakes the steward. The
totals and every box not yet Verified are logged after each pass.

A newer upload never replaces a proposal that was read until it has plans of
its own: while it is being read, or if its read fails, the older one stays in
force and the box says so. (A re-upload of Boss Logistics' UHC Level Funded
quote that failed to read once deleted the good reading it was replacing.)
A quote with more plans than one answer holds is read in halves, down to a
single page, and merged. Tests: `node --experimental-strip-types
scripts/test-proposal-verify.mts`, `node scripts/test-split-read.mjs`.

### Gravie rate workbooks

Gravie returns its quote as an Excel workbook per group. Its **EPO** and
**PPO** sheets each price the same 67 plan designs on Cigna Open Access Plus
(the EPO version has no out-of-network cover, the PPO does), so every group's
Gravie quote is the same 134 plans at that group's own rates. Every plan
card (the popup, the printed proposal, the Excel) carries the same rows for
looking things up — **Network** with a *Find a doctor* link to the provider
directory, and **Pharmacy (PBM)** with a *Formulary* link — filled in where
Kennion has the link and blank otherwise, so every card reads alike. Gravie
has both today: Cigna's public Open Access Plus directory
(`networkDirectory()` in `client/src/lib/model.ts`) and Express Scripts'
Gravie formulary (`pbmOf()`); UnitedHealthcare has the directory —
its Choice Plus guest search (`UHC_DIRECTORY`) — on every plan on the
Choice Plus network; other carriers' links are added there as they
come in. The CSV export carries the addresses in Provider Directory and
Formulary columns, and the assistant gives the same links when a client asks
whether a doctor is in network on a Gravie or UnitedHealthcare plan, or a
drug is covered on a Gravie plan. The
grid itself stays to the network type and name. Some workbooks
also carry a "Narrow Network" sheet (Cigna LocalPlus, offered in a few areas)
and a static benefits grid; both are left out. `server/gravie-parse.js` reads
a workbook, and a zip of them — through the inbox or
`POST /api/admin/proposals/gravie-batch` — files each one twice over: as the
group's **Gravie proposal** (the file, assigned, in the Gravie slot, with the
134 plans in the same shape a Claude-read proposal carries, so the Options
page prices them at once) and as **rows** in `kennion.carrier_quotes` and
`kennion.carrier_quote_plans`, one quote per group, one row per plan.
`GET /api/admin/quotes?carrier=Gravie` lists the quotes and
`GET /api/admin/quotes/Gravie/<group>` returns one with its plans. At boot
every workbook already on file is re-read with the current parser, so a
parser change reaches stored quotes without anyone uploading again.

Carrier proposals — UnitedHealthcare (Surest included), Gravie, Nationwide,
Angle Health and Cobalt — are uploaded on the **Proposals** tab, a whole batch at once,
or one at a time from a company's page. The drop zone takes the proposal in
whatever form it came: a PDF, a spreadsheet, a Word file, a CSV, a picture of
a rate sheet — or the **email itself** (`.eml` from Gmail or Apple Mail, `.msg`
from Outlook). An email is opened on the server, each usable attachment becomes
a proposal of its own, and the email's subject, sender and body go along as
context for the match; logos and signature images are skipped, and an email
with nothing attached is read as the proposal itself. The email is kept too, so
the original can always be opened. Each file is stored whole in Postgres
(`kennion.proposals`) and then read by the extraction agent, Claude Sonnet 5
(`claude-sonnet-5` at high effort, via the Anthropic SDK), in the background: the carrier, the employer named on the
document, the effective date, the carrier's own quote number, every plan with its code,
network and tier rates, and which roster group it belongs to, with a
confidence. A carrier quote runs to many pages and often dozens of options —
the benchmark plans and the alternate and illustrative grids behind them are
all read and stored, since Kennion prices from them; two plans that differ
only by network or deductible are two plans. The reading is streamed with room
for 128,000 tokens of output, because a long quote would otherwise be cut off
mid-plan, and it runs at high effort. A match at 85% or better is **assigned**
to the group; between 50% and 85% it is **suggested** and waits for a click to
confirm; below that the proposal sits in the **to assign** queue with a group
dropdown. Any assignment can be changed.

The reader is asked to copy the matched roster name exactly, and the name
it gives is checked against the roster by `server/proposal-match.js` in
order of trust: the roster name verbatim; the same name once punctuation
and legal-form words are dropped (the reader mirrored the carrier's
spelling — "tpi Global Solutions, Inc." on an Angle Health quote for "TPI
Global Solutions, Inc."); failing that, the employer name it read off the
paper, by the invoice rule (every word of it in one roster name, or a
distinctive first word), and last the file name or the email it came in
(`tpiGlobalSolutions,Inc.` in a file name is read as words). Only the first
two carry the reader's own confidence and can assign outright; a group found
from the paper or the file name is always a **suggestion** to confirm. Two
groups that could both fit leave the proposal unmatched. Every read logs
one line — carrier, the name on the document, what the reader matched and
at what confidence, and the roster outcome — so a proposal that lands in the
wrong place can be explained from the log. Test: `node scripts/test-proposal-match.mjs`.

The tab opens on a **grid of group health quotes**: one row per group, one column per slot, so the
whole book reads at a glance — a filled slot shows the plan count and the
effective date and opens the file; an empty one takes a drop or a click and
uploads straight into that slot. Uploading over a filled slot is how a
proposal is replaced. The grid filters by account manager and by what is
missing (any slot, a named slot, or the groups with every quote in). Under the grid sit
the ones it cannot hold, each in a named bucket: proposals still waiting for a
group, a group health proposal whose slot is not yet decided (a UHC quote that
does not say which funding, say), **ancillary proposals** — dental, vision,
life, disability, no medical rates, so no slot and no part in the 2027 options —
and carriers the portal does not track. The last two start folded.

Claude says outright whether a document quotes medical. A proposal read
before that question existed is judged from the document itself — one that
calls itself ancillary, or names only ancillary products and quotes no rated
plan — and any slot an older reading gave it is cleared, so an ancillary
proposal never sits in a group health column. **Re-read all** on the banner
puts the whole set through the current questions. **List**
and **By group** remain for working through a batch one file at a time.

Each group holds one proposal per **slot** — UHC
Fully Insured, UHC Level Funded, Gravie, Nationwide and Angle (Angle Health).
Cobalt is no longer a 2027 option: its slot is not shown, and a Cobalt
document already uploaded stays stored but is not served. Surest is a
UnitedHealthcare product, so a Surest quote fills that group's
UnitedHealthcare slot for the funding it is written on. Claude fills the slot
from the carrier and funding it reads; staff can change it. A document that
quotes no medical rates (an ancillary proposal for dental, vision or life) or
comes from a carrier outside those six fills no slot: it is kept on file,
marked "not one of the tracked carriers", and stays out of the group's 2027
options. When a newer proposal lands in a slot a group already has, the older
one is **deleted** — one proposal per slot per group, always the latest from
each carrier — after handing its option numbers down to the plans that
survive; the numbers it held are remembered (`kennion.settings`,
`optionIds.retired`) so none is ever handed out again. That current set,
stored in the database, is what the 2027
options for each group will be built from. The extraction is shown under
"Details" for review and is not pushed into the rate tables. The tab has two
layouts: a list, and **By group**, which walks the roster with each group's
proposals attached and ends with the groups still waiting on one. The Groups
page shows a proposal count under each company and can filter to groups with or
without one. Claude also audits
what it reads against the roster — a proposal priced on a very different
headcount than the group's, or a document that names a different company than
the page it was uploaded to, is flagged.

Reading needs an Anthropic key in the environment — `ANTHROPIC_API_KEY`, or
`CLAUDE` as it was first added to Railway. Without it uploads are
still stored and a filename that names a group is used as a hint; staff assign
the rest by hand. Without `DATABASE_URL` proposals live in memory until the next
deploy, and the screen says so.

### The carrier stats report

Employee Navigator's second file, the **Carrier Stats** report
(`carrier_stats_report_yyyy_mm_dd.xls`), is uploaded on the Import tab beside
the XML. It carries EN's own count per carrier — eligible and enrolled
employees, companies, plans, employee cost and total plan cost — and is stored
(`kennion.carrier_stats`, latest wins). The Import tab then shows every carrier
in the report against what the XML import produced, added up the way the
report counts: **every line** a carrier has (medical plus dental, vision, life,
disability …), "enrolled" as **distinct employees** on any of those lines (the
importer keeps a per-carrier head count for each company), and **every
company** — groups archived in the portal are shown in their own column rather
than dropped, because Employee Navigator still counts them. A carrier the
report names twice ("Blue Cross Blue Shield" beside "Blue Cross Blue Shield of
Alabama") is read as one row. Each row shows
enrolled, companies and monthly premium side by side with the difference,
marked **Matches** within 1% or **Check** otherwise. A company with no medical
but with other lines in force is imported too (flagged ancillary-only; it is
not a portal group and cannot sign in) so its lines count. Administrators with
no premium (a COBRA or FSA vendor) are shown greyed.

Under the table, **What the last XML import left out** lists every medical
enrollment the parser did not count — a terminated employee whose coverage has
not ended, an enrollment that has ended, a waived election, a row with no
PlanCost — by carrier and with the premium it carried, so a gap between the
report and the portal is accounted for line by line rather than guessed at.
These diagnostics are stored with each import (`kennion.imports.diagnostics`;
aggregates only). **Ask Claude what explains the gap** sends the report rows,
the per-carrier portal totals and those diagnostics to Claude and shows a
plain-language explanation of which rule differs from Employee Navigator's
counting and what to change; no member data leaves the server.

**Download reconciliation file** produces one small JSON file — the report,
the portal's totals by carrier, the last import's exclusions and every group's
plan classification, with no employee records — for reconciling outside the
server, for instance by attaching it to a Claude Code chat.

Who counts as enrolled follows the report: anyone still on a plan — active, on
leave, on COBRA, a retiree with coverage — while a terminated employee is
skipped, and an enrollment counts until its end date has passed.

### Account managers

Each group carries the Kennion **account manager** who looks after it, Debbie
or Tracy, seeded from `server/data/account-managers.json` (Kennion's own 2026
list) by matching the normalised company name, with a single-candidate prefix
fallback. A manager set by hand in the Groups table wins over the list and is
stored in `kennion.group_meta`. The column sorts, the filter narrows to one
manager or to the groups with none, and the CSV export carries the full name.

### The monthly funding workbook

The third file, Employee Navigator's **funding workbook** for the month
(`September_Funding_….xlsx`), is the billing itself: one line per participant
per product with the rate, for both captives. Uploaded on the Import tab, it is
stored whole (`kennion.funding`; the participant names stay on the server, as
the members do) and every invoice is filed under a group — the workbook names
billing divisions rather than companies, so each invoice goes to the group most
of its billed people belong to, by matching names against the group members the
XML produced; a billing org that simply carries a company's name is accepted
too. Invoices that match nothing (companies not in the export) are listed for
staff to file by hand or leave out.

Enrollment and rates come from the month's own lines: one current line per
participant per plan. A prior month billed late (a retro add) or reversed (a
credit, a negative rate) changes the invoice, not who is enrolled, so those are
kept as adjustments beside the count. A tier's billed rate is the amount most
of its full-month lines carry; a prorated mid-month line counts as a person
but never sets the rate. A line with no rate band is filed under the tier
billed at that amount when exactly one is, and reported as untiered otherwise.
EBPA's dental plans appear on the workbook's "(HEALTH)" sheets and are treated
as lines, not medical, the same as the XML treats them. Billed product names
carry the plan year mid-string and are cut at 50 characters; they are matched
to the XML's plan names with the year dropped and a prefix accepted. A billing
org that is a group's name outright (a typo or two allowed) files the invoice
there even when the people billed match a sister company.

The Import tab then shows, group by group, what the XML says against what the
month's billing says — participants and medical premium, with the difference;
the workbook is the two captives' billing, so the XML side is the group's
EBPA/HealthEZ medical and a Blue Cross plan, billed elsewhere, is left out —
and each company page has a billing panel: every plan and tier with the number
billed and the billed rate, beside the XML's billed rate for that tier. On
upload, and again whenever an invoice is filed by hand, the billed amount is
written as the tier's rate wherever the XML had none or a different one, so the
rates a client sees are the ones actually being billed; **Use billed rates**
(per group, or for every group at once) re-runs that. A billed plan the
group's XML does not carry is left alone and flagged — a question, not a rate.
The client's Current page says the rates shown are the billed rates only when
every billed tier on a census plan is in fact shown at the billed amount.

### 2027 options from the proposals on file

A group's **2027 Options** page is built from the proposals filed in its slots.
When a group signs in, the payload carries its current proposal per slot — the
plans and tier rates Claude read off the document, nothing else — and every
plan with a rate is priced at the group's own census and listed first, marked
*quoted* with the proposal's effective date. A carrier placeholder ("quote
requested") goes as soon as that carrier has quoted, and a menu plan the
proposal also prices is shown at the proposal's rates. The page says which
slots are quoted and which are still out with a carrier. Upload a newer
proposal into the same slot and the page follows it.

The **Current** page carries the month's billing line for the group — how many
medical participants Employee Navigator billed, for how much, with adjustments
and other lines — so what the client sees as "today" is the September snapshot.

### Checking the premium figures

**Existing Plans & Rates** is the rate sheet: every group's plans with the
four tier rates, and a tier-schedule check at the top. Billed rates from
Employee Navigator are locked in black; an empty box shows the rate calculated
at the program tier factors — Employee 1.00, Employee + Child(ren) 1.85,
Employee + Spouse 2.00, Employee + Family 2.85 — in grey, and typing over it
saves a hand-keyed rate to the database. The check counts the plans with two or
more billed tiers whose rates hold those factors; the ones that do not are
flagged "Off schedule" and want the real rates from the carrier sheet.

## Staff sign-in

**This repository is public, so nothing written in it is a secret.** The server
refuses any staff code that has ever appeared here.

The code lives in the database, as a scrypt hash, and is changed from the
**Sign-In Code** panel on the Import tab. That is the whole of it: it survives
every restart, and there is nothing to set on the host.

A database with no code of its own falls back to the hash in
`server/data/admin-seed.json`, so a fresh deploy has a way in without anyone
reading a log. A hash is not a credential — it cannot be turned back into a
code, and this one stands in front of sixty bits of randomness — but it is a
first code, not a permanent one: change it from the panel and it is retired.
With no seed and no stored code, one is minted at boot and printed once.

Setting `ADMIN_CODE` in the environment still wins, for anyone who would
rather keep it there, as does `ADMIN_EMAIL` if the address should not be
`hunter@kennion.com`.

Codes are compared in constant time, failed attempts are counted per caller
and cut off after ten in ten minutes, and every sign-in and refusal is written
to the log with the caller's address.

**Two-factor.** Turn it on from the panel on the Import tab: the app shows a
key to type into Google Authenticator, 1Password, Authy or the like (and an
`otpauth:` link that opens straight into the app on a phone), then asks for the
six digits once to confirm. From then on the sign-in code alone opens nothing —
it also asks for the code the app is showing. Ten single-use recovery codes are
shown once at setup for a lost phone; they are stored only as hashes. Codes are
RFC 6238, thirty-second steps, one step either side allowed for clock drift,
checked in constant time, with the same throttle as sign-in. A session that has
passed the code but not the second factor is a five-minute single-use ticket
that opens nothing on its own. `scripts/test-totp.mjs` checks the generator
against the RFC's own test vectors and `scripts/test-2fa.mjs` walks the whole
flow against a running server.

## Auditing the current rates

Nearly half the tier rates in the portal are not billed rates: 305 of 636 are
the plan's employee rate at the program factors, because Employee Navigator
carried only one or two tiers for that plan. Those are the ones worth checking.

**Audit Workbook For Debbie & Tracy** on the Rates tab builds an Excel file
with one sheet per account manager, holding only their groups. Six columns:

| Group | Plan | Employee | Employee + Spouse | Employee + Child(ren) | Employee + Family |

Nothing else. The rates are typed over in place, so an auditor changes only
what is wrong and leaves the rest alone. A row is found again by its group and
plan, so sorting and filtering are free. Each row is on exactly one sheet, so
two sheets cannot come back disagreeing about the same plan.

The workbook is built in the browser by the same `rateFor` that draws the Rates
screen, so it cannot quietly disagree with the page.

**Sending it back.** Drop the file on the Rates tab. Nothing is written on the
first pass: the panel says how many rates would change, from what to what, and
lists anything it could not read — a zero, an "n/a", a row naming a group and
plan that are not in the portal. Money as people type it ("$1,234.56") is read
as a rate; anything ambiguous is reported rather than guessed at.

Because the sheet shows the rate a tier is *priced* at, the server compares
against that same figure, derivation included — so a workbook that was only
read and returned changes nothing. Comparing against the billed rate alone
would have read all 305 estimates, untouched, as corrections.

**Locking.** When the rates are right, lock them from the same panel. While the
lock is on nothing can change a rate — not a workbook, not a cell typed on the
Rates page — and both are refused with a 423 rather than failing quietly. The
lock records who set it and when, and is lifted from the same place.

`scripts/test-worksheet.mts` checks the workbook against a live server's own
payload; `scripts/test-rates-audit.mts` drives the whole round trip, including
that an untouched workbook is a no-op, and the lock.

## The Assistant

Every client page has a chat box in the bottom-right corner, and the rail has
an **Assistant** tab. They are two views of the same thing: the corner box is
for a quick question from wherever the client is (it opens on their most
recent conversation, with a new one a click away), and the Assistant page is
the full view — every conversation down the left, grouped by day, with rename,
delete and search, and the open one on the right with room for a comparison
table.

**The contribution floor, on every tier.** The Carrier/TPA rule is per
employee, whatever their tier: at least half the Employee Only rate toward
each one. So `contributionFloor` (half the lowest-cost quoted plan's
Employee Only rate, whole dollars, rounded up) holds on all four tiers: a
tier edited below it shows "At least $X" and Apply stays off, and a saved
contribution under it on any tier is lifted on load. Computing it on the
lowest-cost plan is how the rule is met with several plans offered and buy-ups
paid by the employee; a group offering only one richer plan owes half that
plan's Employee Only rate, which the Disclaimers page and the contribution
tip both say, with the Carrier/TPA confirming at enrollment.

**Census: who is enrolled.** Every "N enrolled" on the client pages (the
Employer Contribution band, the Current tab's strip) links to
`/:slug/census`: the Employee Navigator census itself, one row per person
(the employee, then each dependant) in its own columns - First Name, Last
Name, Relationship, Gender, Date of Birth, Zip Code, Tier - with a CSV
download (`GET /api/group/census`, `?format=csv`) and the link to Employee
Navigator, under one line saying it is illustrative and where it came
from. No costs and no editing here; the census lives in Employee
Navigator. The parser keeps each member's date of birth and each
dependant's name, gender, relationship and date of birth (`dob`, `deps`);
groups imported before it did are filled in at boot from the export kept
in the database (`backfillFromStoredExport`), so nothing is re-uploaded.

**Illustrative quotes, and the notice.** Every rate the site shows is an
"Illustrative Quote" (`basisOf`), never a proposal, an offer or a guarantee,
and one notice (`RATE_DISCLAIMER` in `client/src/lib/model.ts`, the same
text in `server/disclaimer.js`, kept identical by
`scripts/test-disclaimer.mjs`) sits under every rate: the page footer, the
plan card, the printed proposal, every PDF's footer, every workbook and the
assistant's documents. The assistant's instructions say the same. BenSync is
a proposal platform; the notice is what makes that safe.

**Group size, as a note.** The Group Size badge (2-50 or 51+, from the
enrollment data on file) sits beside the Medical Plans title on the 2027
options and current plans tabs, and nowhere else: the Welcome page opens
without it. It carries an info tip per category (`groupSizeNote`):
where the size comes from, what applies at that size (the ACA employer
mandate at 50 or more full-time equivalents; not under 50), that the 50%
starting contribution is the Carrier/TPA's minimum contribution requirement and not an
affordability determination, and that the AI Assistant and the Kennion team
help work through it. The Employer Contribution tip says the same in one
sentence, and the assistant's instructions carry the rule. The page never
says a contribution is affordable or compliant; Kennion is the broker.

**The picks stand against each other, not against today.** The plans in
force today are not an option for 2027, so the AI Picks report, the
Favorites and Comparison PDFs and the assistant's pick reasons never say
"vs today" or how much a new option costs over today's: no today rows, no
today line on the chart, no "like today's Gold plan". The chat can still
explain today's plans when asked; the picks and their documents compare the
quoted options with each other.

**One name for a plan, everywhere.** A plan is its Carrier/TPA, the word
Option and its ID, in bold: **Angle Health Option AN19**. The plan card's
title, the comparison and the AI Picks report say it that way with the
carrier's long product name under it, and the assistant's instructions say
the same for its answers, pick reasons and summaries (the long name at most
once, in parentheses, never first).

**The grid opens on All.** Every time: a refresh, the Current tab and
back, a new sign-in. It moves to AI Picks only when a run started on that
page lands, never on loading saved picks; the saved picks still mark their
rows and the AI Picks segment still counts them.

**Each view in its natural order.** Switching the grid to All sorts by
total monthly bill, low to high; switching to AI Picks, Favorites or
Compare sorts by option ID, so a chosen set reads carrier by carrier. The
sort control still changes it after.

**No dashes as punctuation.** Nothing the app shows or writes uses an em
dash or an en dash: not the pages, the PDFs, the spreadsheets, the emails or
the assistant's replies (its instructions say so, and the PDFs' standard
fonts render them as boxes anyway). A comma, a colon, a period or a plain
hyphen does the job. `scripts/test-no-em-dash.mjs` scans the client, the
server and the scripts and fails on one.

**AI Picks.** On the 2027 grid's toolbar, beside Favorites and Compare,
an "AI Picks" view. With no picks yet, pressing it opens the chat box on a
conversation named "Plan recommendations" and asks for recommendations on
the client's behalf — once: the send carries the name (`title` on `POST
/api/chat/send`), and while the group has a conversation of that name
without picks the button reopens it rather than asking again
(`askQuietly` in `client/src/lib/chat.ts`) — without opening the chat box.
While it works, an "Analyzing your group" dialog shows what the picks are
weighed on: the census as aggregates (`census` on the group payload — the
same profile the assistant is briefed with: employees, average and median
age, the range and how tight it is, employees by age band, dependants)
and the three steps under way; it closes itself when the picks land. Then
the view switches on: the grid shows just those plans, each tagged Lower
Cost, Best Fit or Richer Benefits (a star on the one to start with), and a
row's plan card opens with the assistant's one-line reason on top. Every
row also carries an AI-pick mark beside the heart and the plus — lit on a
picked plan whatever view is on — so the picks read at a glance among all
plans. The rule is three picks per lineup — a carrier and a funding — so
where UnitedHealthcare has quoted both fully insured and level funded, each
gets its own Lower Cost, Best Fit and Richer Benefits (`buildRecommendations`
keys picks by slot and tier). The picks are saved per group and replaced
whenever the assistant gives a new set: from the ↻ inside the AI Picks segment
once picks exist (new quotes or a changed contribution can change them), or
from the chat, which is where any question about them goes. The picks and
their reasons are stored per group (`kennion.plan_recommendations`, one row
per group, replaced on each run) and kept as a document from the grid's
Export menu: on the AI Picks view, "AI Picks report (PDF)" (`POST
/api/group/export` with `view: "picks"`, `renderPicksReport` in
`server/documents.js`) — the census the picks were weighed on with age-band
and tier charts, where to start, each lineup's three picks with the figures
at the group's enrollment and the assistant's reason, the bills side by
side against today's, and how the picks were made. The same menu always lists
Favorites and Comparison as PDFs of those plans, and "All Plans (Excel)":
every 2027 plan's card as one row of a workbook (`planSheet` in
`OptionsGrid.tsx` builds the columns and rows from the card model, the
server writes the file with `renderPlanSheet`), no current plans and no
comparison, a header row Excel can filter and an About sheet naming the
group, enrollment and contribution. A set with nothing in it is greyed. The heart has no
rules: any plan can be a favorite, as many as you like — Sign Up is where
the one-carrier, one-funding rule is applied. The assistant answers straight
away with three picks per carrier that quoted — Lower Cost, Best Fit, Richer
Benefits — each by option ID with its monthly cost at the group's census,
says which it would start with, and closes by asking for a budget or
must-haves so it can sharpen them. For this the model is handed a census
profile (`censusProfile` in `server/index.js`): the number of enrolled
employees, average, median, youngest and oldest age, whether the range is
narrow, moderate or wide, counts by age band, and how many cover a spouse
or children. Aggregates only — no name and no one person's age leaves the
server. A young, tightly grouped workforce with few dependants can be
pointed at a higher-deductible design; a wide range or an older workforce
gets a Best Fit pick that protects the people most likely to use care.

Each answer is written with the group's own figures in front of the model
(`server/assistant.js`, `describeGroup`): the plans and tier rates in force,
the employer/employee split where Employee Navigator has one, every carrier
quote on file for 2027 with its plans and rates, this month's billing, the
last Sign Up submission, and the account manager to hand off to. It is the
same allow-listed view the group's pages get — no census, no other company —
so the assistant cannot say anything the client could not already read on the
site. The question notes which page it was asked from.

**Headcount.** The only headcount the assistant is given is who is enrolled.
The briefing used to carry the Employee Navigator roster count as "active
employees on the census" — every `<Employee>` in the company's export whose
status is not Terminated — and the assistant repeated it when a client asked
how many employees they had. That count is not eligibility: Employee
Navigator's *Active* status covers part-time and PRN staff, classes that are
not benefit-eligible and records nobody ever closed, so on some groups it ran
to many times the enrolled figure (326 against 40 enrolled on one). It is now
a staff figure on the **Data Check** tab, the briefing says plainly that no
verified total or eligible headcount is on file and that the account manager
can confirm one from the census, and the client's **Group Size** badge reads
the size category staff keep on the company page rather than that count. Replies stream over
server-sent events (`POST /api/chat/send`); conversations are kept in
`kennion.chat_threads` / `kennion.chat_messages`, scoped to the group, and in
memory when there is no database. The box and the tab only show when the
server has an Anthropic key (the sign-in payload says so).

**Documents.** The assistant can hand back files (`server/documents.js`),
attached to its answer as downloads (`kennion.chat_files`, served at
`/api/chat/files/:id` by the group's cookie alone): a side-by-side
**comparison** of chosen 2027 options at the group's own enrollment, with
today's plans above and optional employer/employee split columns, as PDF or
Excel — the numbers are computed on the server from the quotes on file, the
model only picks the plans — and a **memo, summary or announcement** the
model writes in Markdown, rendered as a branded PDF or Word file. These are
tools on the model's turn (`create_comparison`, `create_document`); a turn
runs at most five tool rounds.

**Advice and memory.** Asked what to do, the assistant recommends — named
plans, the why in the group's own figures, what would change its mind — and
asks two or three qualifying questions first when it does not know what the
client cares about. What the client tells it (a budget, a contribution
philosophy, a network must-have, a plan they ruled out) it records with the
`update_client_memory` tool, one plain sentence per line in
`kennion.client_memory`; every later conversation for that group starts from
those lines. The client sees them behind the **Memory** button on the
Assistant page — a count on the button, a panel with every line, a way to
remove any, and a box to add one of their own (`POST /api/chat/memory`) —
the way an assistant's memory usually works; staff see and edit them in the
conversation drawer on `/admin/assistant` (`/api/chat/memory`,
`/api/admin/chat/memory`).
The Assistant page has two tabs, **Chat** and **Documents**. Documents is
one place for every file of the group's: what the assistant made in its
conversations (comparisons, memos), what the client attached to a
question, and what the client adds there itself (`POST /api/chat/files`,
kept until removed, never swept) — newest first, each linking back to its
conversation, with Download and Delete (`GET`/`DELETE /api/chat/files`; a
deleted file leaves the answer it hung on too).
The model is Claude Fable 5.1 (`KENNION_MODEL` overrides), falling back to
Claude Opus 5 for the life of the process if the account cannot use it.

**One group per tab.** The session cookie is one per browser, so a staff
member with two groups open in two tabs would otherwise have the second
sign-in answer the first tab's questions with the wrong group's figures.
Every request a group's page makes — chat, memory, attachments, documents,
support tickets — names its own group in a header carrying that
group's own credential (`X-Kennion-Group-Token`, the permanent-link token,
or `X-Kennion-Group-Code`), and the server answers for that group
(`groupForPage`). A header naming no real group is refused, never ignored.

**Current plan designs.** The 15 medical plans in force today across EBPA
and HealthEZ — Deluxe Platinum through Freedom Bronze — are on file with
every benefit line from Kennion's comparison sheet
(`server/data/plan-docs/KennionHealthPlansComparison.{pdf,xlsx}`, the same
values as `planDesigns` in `server/data/kennion.json`). At boot the server
seeds them into `kennion.plan_designs`, one row per plan name, and from then
on reads them from there; `GET /api/admin/plan-designs` lists them and
`POST /api/admin/plan-designs/:name` corrects one. The assistant's figures
carry each current plan's design beside its rates and the whole catalogue
in one line each, so it can compare what a group has today with the 2027
options. Test: `node scripts/test-plan-designs.mjs`.

**Standard plan designs (the plan catalogue).** A carrier quotes the same
standard designs to every group; only the rates differ. Angle Health's 19
designs - ANG TRAD 5000 7000, ANG HDHP 3500 3500, ANG VALUE 9200 and the
rest - are on file as a catalogue
(`server/data/plan-docs/AngleHealthStandardPlanBenefits.xlsx`: a Plans sheet
with one row per design and its in- and out-of-network deductibles and
out-of-pocket maximums, and a Benefits sheet with one row per service line,
20 per design, exactly as printed on the carrier's plan pages). At boot the
server reads the workbook, seeds `kennion.carrier_plan_designs` where the
carrier has no rows yet (one row per carrier, plan year and plan code; rows
in the database win over the file), and keeps the catalogue in memory keyed
by carrier and plan code (`server/plan-catalogue.js`). Every quoted plan
whose printed name or code is a catalogue code then carries the catalogue's
figures wherever the plan appears - its card, the printed proposal, the
comparison, the assistant's figures - in place of what the reader made of
the carrier's PDF: the deductible and OOP max, the design family as its type,
the six benefit rows plus the emergency room, and the whole design (family
figures, out-of-network cover, whether the family deductible is embedded,
all 20 lines) under `design`. The group's own rates are never touched. A plan
that is not a catalogue design is left as read. On the Import tab, **Plan
Design Catalogue** lists each carrier's designs and takes a catalogue
workbook for a carrier (`POST /api/admin/plan-catalogue/:carrier`, the same
two-sheet shape), adding or replacing designs by plan code; the rest of the
carrier's catalogue stays, and every group's proposals from that carrier
carry the designs at once. `GET /api/admin/plan-catalogue` lists it.
UnitedHealthcare's and Gravie's catalogues load the same way once they are in
that shape. Test: `node scripts/test-plan-catalogue.mjs`.

**Research.** The assistant can search the web (Anthropic's server-side
`web_search` tool, up to five searches a turn) for what the group's figures
do not cover — an ACA affordability percentage, an IRS limit, a carrier's
network, a regulation, how employers of their size compare (KFF, MEPS-IC)
— and says what it found and where in words. It
never searches for the group's own numbers. `KENNION_WEB_SEARCH=0` turns it
off.

**The admin's side** (`/admin/assistant`) is where Kennion steers it:

- **Playbook** — three plain-English boxes that go into every answer's
  system prompt, so a change takes effect on the next question with no
  deploy: *who it is* (the persona — a licensed advisor on the Kennion team
  who specializes in level-funded and fully-insured group health), *rules*
  ("never describe 2027 as a rate increase", "always mention the
  level-funded refund"), and *house answers* (questions with the answer you
  want given verbatim). Kept in `settings` under `assistant.playbook` with
  the last twenty versions; the defaults live in `server/assistant.js`.
- **Try it as a group** — ask as any client and see what the assistant says
  with the playbook as saved. Those conversations are kept (`staff = true`)
  but never shown to the client.
- **Conversations** — every thread across every group: first question,
  turns, last active; filter by group, search inside questions and answers,
  open the transcript with its documents, **flag for follow-up** with a
  note for the account manager, delete.

## Privacy

The census carries names, ages, genders, ZIPs and premiums for over 1,300
people, so it is **never served as a static file**. It is read privately by the
server and handed out one group at a time via `POST /api/signin`, in exchange
for that group's code. A wrong code gets a 404 and no data. Rate Administration
receives a projection with group names, plans and rates but **no member
records**. Access codes are resolved server-side and never reach the browser, so
they cannot be enumerated from the bundle.

## Where the numbers come from

`server/data/kennion.json` is the shipped baseline, built from the Employee
Navigator Data API export of 7/31/2026 and the UnitedHealthcare full-menu quotes
of 8/28–8/31/2026: 68 groups and 1,318 employee records. Imported groups are
layered over it.

The census is medical only. The Groups dashboard's **group health premium** is
the monthly premium of each group's medical plans whose carrier matches EBPA or
HealthEZ — the same tolerant carrier match that decides program eligibility —
so BCBS of Alabama medical never counts toward it. **Total premium** adds every
other benefit line the export carries. Those lines are only captured when an
export is imported (see below), so a group still on census data, or imported
before supplemental lines were read, shows a total equal to its medical
premium and is flagged as not yet loaded. Re-importing the Employee Navigator
export once fills the supplemental figures in for every group in it.

Three rules govern every rate, and the UI labels which applies:

| Source | Shown as | Meaning |
| --- | --- | --- |
| **Billed** | plain | Employee Navigator has a premium for this tier, because someone is enrolled in it. |
| **Calculated** | `calc.` | Nobody is enrolled in this tier, so nothing is billed for it anywhere. Derived at the program tier factors — EE 1.00 / EE+SP 2.00 / EE+CH 1.85 / EE+Family 2.85. Never contributes to a total. |
| **Manual** | blue, in Rate Admin | Keyed by hand from a carrier rate sheet. Beats both of the above. |

Of the 165 billed non-employee tier rates in the export, 161 reconcile within
the 0.5% tolerance the app uses, and 155 are exact to the cent. The four that
miss belong to three plans — Forestry's EBPA Preferred Silver and EBPA Deluxe
Platinum, and Electrical Repair's EBPA Platinum 150. Those are flagged **Off
schedule** in Rate Admin, and their calculated tiers are described to clients as
approximate pending the TPA rate sheet rather than as confident numbers.

Employer/employee split is **actual** — read from the Employee Navigator payroll
configuration — for groups whose export has been loaded, and is not adjustable
there. Groups without one show a "Pending" notice and placeholder percentages,
clearly labelled; their total premium is billed data and is correct.

## The Import tab

The snapshot is taken once a year: three files from Employee Navigator go in,
and from then on the portal does the work. At the top of the tab sits **the
audit**, computed on the server after every upload and at boot: which of the
three files are in, the verdict in one line (carriers that match Employee
Navigator's report, groups whose billing matches the XML, invoices still
unfiled), the portal's headline figures, and — once all three files are in —
**Claude's read** of the whole picture, written for an advisor and kept in the
database (`kennion.audits`, one per combination of uploads) so nobody presses
anything and the model is never asked twice for the same files. "Show the
numbers" opens the per-carrier rows.

Below it, three numbered sections, one per file, in the order they are used:
the **XML export**, the **carrier stats report**, the **monthly funding
workbook**. Each shows the file it wants, a Choose file button, the
last upload (file, time, who), a one-line result, and a status pill; the
tables, diagnostics and per-group checks sit behind "Show details". An XML
import waiting to be confirmed keeps its details open. The XML import history
is a collapsed list at the bottom.

## Importing an Employee Navigator export

Upload an EN XML in Rate Administration — a single group, or a full Data API
export with every company in it. The document root is `<Company>`, so a full
export is a run of them; they are streamed and parsed one at a time, so a
100 MB+ file never lands in memory whole (a 107 MB export parses in about six
seconds under a 400 MB heap).

The parser builds the group's members, plans and rates from **active medical
enrollments only** — `Benefit=Medical`, `EmploymentStatus=Active`, and no
`EndDate` — and reads `CoverageLevel` as the tier, `PlanCost` as the billed
rate, and `EmployeeCost`/`EmployerCost` as the actual split. Every other
benefit in the export (dental, vision, life, disability, accident, cancer …) is
read under the same active / no-`EndDate` rule, but only as a per-line total —
benefit, carrier, plan, enrolled count and the sum of `PlanCost` — for the
Groups dashboard's total premium; no member detail is kept for those lines, and
a waived or declined election is skipped. Dependent ages come from the nested
`<Dependent>` records; the carrier for every line comes from the `<Plans>`
catalog. The `<Company>` record supplies the
full group identity — address, city, state, ZIP, SIC code, EIN, phone, situs
state, corporation type and the named contacts. The one thing it lacks is the
SIC *description*, which is carried across from the census on import rather
than being lost. Plan names have their trailing year stripped so they match the census.

### What an import does and does not overwrite

An imported company is matched to an existing group by name, and if that fails,
by a **normalised** name — punctuation and legal-form words removed — so
"Aesto Health, LLC" updates "Aesto Health" instead of landing beside it as a
second copy of the same client. The match is verified not to merge any two of
the 68 census groups. The existing group's name stays the key, because access
codes, hand-keyed rates and ALE buckets are all filed under it; the export's own
spelling is kept alongside and shown in the table.

Rows that are the same client under two names — created before this matching
existed — are flagged in the Groups table with the row they duplicate, so the
stale one can be archived.

An import **never deletes a group**. Only the companies you tick are touched;
every other group is left exactly as it was, so a partial export cannot wipe the
roster. One thing a full export does say: a company it no longer carries has
left. When an export holds at least half the roster, a census-only group (one
never imported) that is absent from it is **archived** and marked "not in the
Employee Navigator export", once; restoring it by hand sticks, and later imports
leave it alone. Staff edits live in their own tables and survive imports
untouched: hand-assigned access codes, ALE buckets and hand-keyed rates all
persist.

Company records the parser could not use (no plans, no enrollments) are kept
in the import's record as rejected, with the reason, and listed under "What the
last XML import left out" beside the excluded medical enrollments and the
non-medical lines left out by the same rules. Coverage runs through its end
date: a line ending today is still on.

Within a group that you do import, the enrollment **is replaced** rather than
merged, and that is deliberate. An export is a snapshot: if someone terminated
since the last one, merging would leave them enrolled forever and every total
would drift upward. Replacing the group means its census matches the export you
just uploaded.

The Groups table shows, per group, whether its data came from an XML import and
when, or is still the shipped census.

Nothing is saved until you confirm. The preview lists every company found with
its EN identifier, enrolled count, monthly premium and whether actual splits
were found, each against what that group currently has — so a newer export that
legitimately moves the numbers does so visibly. Tick the ones to import.
Importing replaces those groups outright; access codes are unchanged. Company
records with no active medical enrollment are named and skipped rather than
failing the batch.

## Storage

Set `DATABASE_URL` and Postgres becomes the source of truth for everything a
human enters:

| Table | Holds |
| --- | --- |
| `kennion.groups` | one row per imported group — EN identifier, access code, full payload and contribution split, with `imported_at` / `imported_by` |
| `kennion.group_meta` | staff-assigned access code and ALE bucket per group |
| `kennion.rate_overrides` | hand-keyed rates by group + plan + tier, with `updated_at` / `updated_by` |
| `kennion.imports` | one row per upload — filename, when, by whom, companies found and applied |
| `kennion.proposals` | one row per carrier proposal - the file itself (`source_sha` its SHA-256), the canonical plans read off it (`extracted`: plans with provenance, excluded EPO plans, the count reconciliation, the correction log), the dual audit (`audit`), its processing `stage` and `stage_reason`, the group it is assigned to and by whom |
| `kennion.carrier_quotes` | one row per carrier and group: quote number, effective date, subscribers quoted by tier, plan count — replaced when a newer workbook comes in |
| `kennion.carrier_quote_plans` | every plan on that quote as a row: name, family, EPO or PPO, deductible, out-of-pocket max, coinsurance, the four tier rates and the monthly at the quoted tiers |

Everything lives in a dedicated `kennion` schema. The database may already carry
tables from a previous application — a `public.groups` from the old platform is
exactly such a case, and an unqualified `CREATE TABLE IF NOT EXISTS groups`
silently does nothing against it, then inserts fail on the wrong columns. The
schema keeps this app's tables from colliding and leaves anything in `public`
alone. It is created on start; there is no migration step.

Rate edits are written to the database as they are typed, so they are shared
across the team rather than living in whoever's browser typed them.

Without `DATABASE_URL` the portal still runs: imports fall back to
`$DATA_DIR/imported-groups.json`, and since Railway replaces the container
filesystem on every deploy, `DATA_DIR` needs to point at a mounted volume for
those to survive. The admin screen states which of the three modes is in effect.
A database that is configured but unreachable is logged and the site serves the
shipped census rather than failing to boot.

### The inbox

Files too large or too binary to travel through a chat or an env var — a zip
of client invoices, a carrier report — reach the app through its **inbox**:
the app fetches them at boot and ingests them into Postgres. `server/inbox.js`
reads three variables, all optional:

| Variable | Does |
| --- | --- |
| `INBOX_PRESIGN=inbox/a.zip,inbox/b.xls` | logs a one-hour upload URL per key in the storage bucket (`S3_BUCKET` and friends) |
| `INBOX_INGEST=inbox/a.zip,https://…/b.xls.enc` | fetches each entry — a bucket key or a URL — and ingests it by extension: `.zip` as a month of invoices, `.xls`/`.xlsx` as a carrier stats report |
| `INBOX_MONTH=2026-09` | the invoice month for any zip ingested |

Every boot makes sure the app has an **inbox key pair** — RSA, made once and
kept in `kennion.settings` under `inboxKey` — and prints its public half as one
line, `[inbox] PUBLIC KEY …`. A file **sealed** to that key can sit anywhere
public until the app picks it up: `node scripts/inbox-seal.mjs <public key> <file>`
writes `<file>.enc`, a random AES-256-GCM key wrapped with RSA-OAEP to the
app, and only the app can open it. An `.enc` entry in `INBOX_INGEST` is opened
before ingest. Each ingested file is archived to the bucket under `archive/`,
and the result of every entry is logged, never thrown, so a bad file cannot
keep the site from booting. Clear `INBOX_INGEST` once the log shows the file
landed, or the next boot ingests it again.

## The Data Check tab

The snapshot audit on the Import tab reconciles the three Employee Navigator
files with each other in aggregate. **Data Check** (`/admin/data`,
`server/data-audit.js`) is per company: every group on the roster checked
against itself and against every other file the portal holds about it, so a
wrong figure is caught here before a client reads it on a page or hears it
from the assistant. It is computed on request from what is in memory, so it
is always about the data as it stands. The checks, in the order shown:

| Check | What it looks at |
| --- | --- |
| Enrolled count | The group's enrolled figure equals what its plans add to, what its tiers add to, and the census it was built from. |
| Premium | The monthly medical premium equals the plans' total and the census's, and annual is twelve times it. |
| Coverage tiers | Every enrolled person is on a coverage level the pages can price. |
| Billed rates | A billed rate behind every tier somebody is in, and the rates × heads reproducing what each plan bills (else "off schedule"). |
| Employer/employee split | Whether payroll's split came through, or the pages say Pending. |
| Headcount | The Employee Navigator roster (status Active) against who is enrolled. Flagged when the roster is more than three times the enrolled count and 20 people over — the sign of a roster full of part-time, ineligible or never-closed records. Never shown to a client or to the assistant. |
| Size category | The 2-50 / 51+ bucket the client's Group Size badge shows: set by staff, or defaulted from the enrolled count — and flagged when the roster would put it on the other side of the line. |
| Program carrier | On EBPA, HealthEZ or BCBS of Alabama, with every plan's carrier read rather than assumed. |
| This month's billing | The funding workbook against the XML for the group's captive plans: the month's participants and premium, then every billed plan and tier against the census's heads and the XML's billed rate for that tier — a rate that differs by a cent, a tier two people out, or a plan billed that the group's XML does not carry is flagged. |
| Supplemental lines | Whether dental, vision, life and the rest were captured for the group. |
| 2027 quotes | Every proposal on file has plans with rates and is priced on this group's headcount; no EPO plan is stored on any of them, and a Gravie quote is the same 67 PPO designs every group gets. |
| Account manager | One is assigned, so the assistant names a person rather than the fallback contact. |
| Client access | The code and a permanent link. |
| Import | When the group was last imported, and whether the newest export still carried it. |
| Identity | Duplicate spellings of the same company, and whether contacts came through. |

Groups that need a look come first; "only groups that need a look" is the
default view, and archived or not-in-program companies can be shown for a
complete roster. Opening a group lists every check with its verdict, links to
the company page, and shows **what the assistant is told** — the briefing
`describeGroup()` builds for that group, word for word, so staff can read
exactly what the client's assistant knows before the client asks. Aggregates
only: no member is named anywhere in a result (`scripts/test-data-audit.mjs`
and `scripts/test-group-payload.mjs` hold that line).

The tab is the one place all three Employee Navigator files are set against
each other and against what clients are served:

- **The three files, audited** sits at the top — the same snapshot audit the
  Import tab shows: which files are in, every carrier in the Carrier Stats
  report against the portal on the report's own basis, billing against the
  XML, and Claude's read of it.
- **The stored export, re-read.** The XML is kept in Postgres, gzip-compressed,
  with every import (`kennion.imports.raw_gzip`). This parses that file again
  from scratch and sets every company in it against the group the portal
  serves — enrolled, premium, each plan's heads and premium, supplemental
  lines — and lists what differs field by field, which companies are in the
  file but not the portal, and which the portal serves but the file no longer
  carries. Run on request (`POST /api/admin/data-audit/verify-xml`; a full
  export takes a little while); the result is kept in `kennion.settings` under
  `dataCheck.xmlVerify`, says which export it was run against, and is marked
  stale once a newer export lands.
- **Every group, checked** — the per-group checks above. The check runs at boot
  and after every upload as well as on request, and each result is kept in
  `kennion.audits` under a fingerprint of the data it describes (the three
  uploads, the stored-export re-read and the findings), so the same state is
  one row updated in place and any change is a new one: what was found, and
  when, is never lost.
- **Claude's read** of the findings, on request (`POST
  /api/admin/data-audit/read`): which groups to look at first, the most likely
  cause and the one thing to do, and what is expected rather than wrong. The
  checks are arithmetic done on the server; the model explains them and never
  decides a figure. A read is kept in `kennion.audits` under the same
  fingerprint, so the same state of the data is never read twice.

- **A second read (ChatGPT)**, on request (`POST
  /api/admin/data-audit/read?by=chatgpt`): the same findings read by ChatGPT
  without seeing Claude's answer, so two readers that agree on what to look at
  first are worth more than one. The key is the `ChatGPT` variable on Railway
  (`CHATGPT_API_KEY` or `OPENAI_API_KEY` also work); the model defaults to
  `gpt-5` and can be pinned with `CHATGPT_MODEL`. Kept in `kennion.audits`
  under its own fingerprint. Without the variable the button says so.

Two models read the findings; neither decides a figure. Every number on the
tab is arithmetic done on the server against the three Employee Navigator
files, and the checks are the record where the two reads differ. Claude is
also the assistant's model (`server/assistant.js`); ChatGPT is used for this
second read only.

## Known gaps

- The EBPA and HealthEZ 2026 rate sheets would replace every `calc.` label with
  a published number.
- The 2027 grid is the group's proposals and nothing else: every plan name
  and rate is read off a carrier's own document by the reader, checked by
  the audit and stored in the database. The seed's UnitedHealthcare
  full-menu quotes (August, rates for some tiers only) are not proposals
  and are not shown; nothing is scaled or stood in for, so a group with no
  proposal on file sees no 2027 options yet. A plan whose rates miss a tier
  the group has people in is not shown either.
- Staff sessions are held in memory, so a restart signs staff out and a
  multi-instance deployment would need a shared session store.

## Run

```bash
npm install
npm run dev      # Vite dev server
npm run build    # type-check + production build to dist/public
npm run start    # serve the build on $PORT (default 5000)
```

Parser and pricing checks, no database or key needed:

```bash
node scripts/test-en-parse.mjs && node scripts/test-en-tiers.mjs && node scripts/test-en-ancillary.mjs
node scripts/test-carrier-stats.mjs && node scripts/test-funding.mjs && node scripts/test-ancillary.mjs
node scripts/test-group-payload.mjs   # boots the server on 5077 and checks group isolation
node scripts/test-chat.mjs            # boots the server on 5078 and walks the assistant end to end
node scripts/test-proposal-audit.mjs  # boots the server on 5086: read, two-model audit, client view, document
node scripts/test-option-ids.mjs      # boots the server on 5089: UH1/GR1 numbering, re-reads, newer quotes, sign-up
node scripts/test-plan-designs.mjs    # the 15 current plan designs in the assistant's figures and the staff routes (5091)
node scripts/test-plan-catalogue.mjs  # Angle Health's 19 standard designs: parsed, matched by code, listed and loaded by staff, on the group's page (5093)
node scripts/test-totp.mjs && node scripts/test-2fa.mjs   # two-factor, against the RFC vectors and a live server
node --experimental-strip-types scripts/test-market-plans.mts
```

`KENNION_FAKE_AI=1` makes the server treat a text upload whose body is a JSON
extraction as Claude's reading of it, and answers the assistant with a canned
reply (with a real comparison or memo file when the question asks for one),
so the whole proposal path and the chat can be walked locally without a key.
It is for local runs only; never set it in a deployment.

## Deploy

Railway, nixpacks — see `railway.toml` / `railway.json`. `npm run build`
produces `dist/public`; `npm run start` serves it through a small Express
process with a `/healthz` check.

The build command is `npm install`, not `npm ci`: Railway mounts a build cache
at `/app/node_modules/.cache`, and `npm ci` removes `node_modules` wholesale, so
it fails trying to `rmdir` that mount point with `EBUSY`.

Environment variables, all optional: `DATABASE_URL` (Postgres), `ADMIN_EMAIL`
and `ADMIN_CODE` for staff sign-in, `ANTHROPIC_API_KEY` (or `CLAUDE`) so uploaded
proposals are read and matched to groups and the assistant can answer, `DATA_DIR` for a writable volume when there is
no database, and `PORT` (defaults to 5000). Set the admin values in Railway
so the real credentials are not the ones committed here.
