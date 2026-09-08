# Kennion 2027 Renewal Portal

A group-facing renewal portal for Kennion Benefit Advisors. A group signs in
with its access code and sees two things:

1. **Current Medical Plan(s)** — the plans in force for the 2026 plan year,
   with 4-tier composite rates, enrollment by tier, and total monthly employer
   cost / employee cost / premium per plan. An **Employee Cost Breakdown** opens
   named employee detail with ages, tier and per-person EE/ER/total, switchable
   between monthly, semi-monthly, bi-weekly and weekly.
2. **2027 Medical Plan Options** — the shopped market (UnitedHealthcare Level
   Funded, Gravie, Nationwide, Angle, Cobalt), every plan costed at the group's own census,
   with three Kennion recommendations above a sortable 95-plan grid. Groups
   build a shortlist and send it with a note to their rep.

Both sections print to a clean report, and every page carries the carrier
disclaimer footer — including in print.

## Pages and addresses

The portal lives at **https://app.kennion.com**. Every page has its own address,
so the browser's back and forward buttons work, a page can be bookmarked or sent
as a link, and a reload comes back to the same place.

| Address | Page |
| --- | --- |
| `/` | Group sign-in |
| `/current` | Current Medical Plan(s) |
| `/options` | 2027 Medical Plan Options |
| `/admin` | Staff sign-in |
| `/admin/groups` | Rate Administration — Groups |
| `/admin/groups/<company name>` | One company's page |
| `/admin/rates` | Rate Administration — Plans & Rates |
| `/admin/import` | Rate Administration — Import |

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

A group can be **archived**: it drops out of the list and its access code is
refused at sign-in, but nothing is deleted and it can be restored at any time.

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

Every group also has a **permanent address** of its own:
`https://app.kennion.com/g/3EzxfXfLz9HWv59zqNklMQ`. The token is 22 random
characters, minted once and kept in `group_meta.link_token`, so it survives
deploys and imports and cannot be guessed from a company name the way a code
can. It stays in the address bar — both tabs live under it
(`/g/<token>/options`) — so the page can be bookmarked, reloaded and sent to a
client with no code to type. Signing in with a code lands on the same address.

Every company page shows the link with a Copy button and a **New link** button
that mints a fresh token and kills the old one, every row in the Groups table
has a **view as client** link, and the CSV export carries a Client link column.
An archived group's link is refused, as its code is. `/?code=XXXX` still works
and redirects to the group's permanent address.

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
(`kennion.proposals`) and then read by Claude (`claude-opus-5`, via the
Anthropic SDK) in the background: the carrier, the employer named on the
document, the effective date, the carrier's own quote number, every plan with its code,
network and tier rates, and which roster group it belongs to, with a
confidence. A carrier quote runs to many pages and often dozens of options —
the benchmark plans and the alternate and illustrative grids behind them are
all read and stored, since Kennion prices from them; two plans that differ
only by network or deductible are two plans. The reading is streamed with room
for 64,000 tokens of output, because a long quote would otherwise be cut off
mid-plan, and it runs at high effort. A match at 85% or better is **assigned**
to the group; between 50% and 85% it is **suggested** and waits for a click to
confirm; below that the proposal sits in the **to assign** queue with a group
dropdown. Any assignment can be changed.

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
Fully Insured, UHC Level Funded, Gravie, Nationwide and Angle (Angle Health),
plus Cobalt (a self-funded quote) for the groups Cobalt is quoting, listed in
`server/data/cobalt-groups.json` and matched by normalised name. A group not on
that list shows a dash in the Cobalt column and is never counted as missing it;
upload a Cobalt proposal for one and the slot appears, so nothing is hidden. Surest is a
UnitedHealthcare product, so a Surest quote fills that group's
UnitedHealthcare slot for the funding it is written on. Claude fills the slot
from the carrier and funding it reads; staff can change it. A document that
quotes no medical rates (an ancillary proposal for dental, vision or life) or
comes from a carrier outside those six fills no slot: it is kept on file,
marked "not one of the tracked carriers", and stays out of the group's 2027
options. When a newer proposal lands in a slot a group already has, the older
one is marked **superseded** and kept, so the current set is always the latest
from each carrier. That current set, stored in the database, is what the 2027
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
refuses any staff code that has ever appeared here. Set `ADMIN_CODE` in Railway
(and `ADMIN_EMAIL` if it should not be `hunter@kennion.com`) to a code of your
own; that is the only setting that survives a restart. With none set, the
server mints a strong one at boot and prints it once in the deploy log, so
there is always a way in without a guessable code ever being live.

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
| `kennion.proposals` | one row per carrier proposal — the file itself, what Claude read off it, the group it is assigned to and by whom |

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

## Known gaps

- The EBPA and HealthEZ 2026 rate sheets would replace every `calc.` label with
  a published number.
- Gravie shows "quote requested" rather than invented rates. Surest is priced
  only where UnitedHealthcare included it.
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
node scripts/test-totp.mjs && node scripts/test-2fa.mjs   # two-factor, against the RFC vectors and a live server
node --experimental-strip-types scripts/test-market-plans.mts
```

`KENNION_FAKE_AI=1` makes the server treat a text upload whose body is a JSON
extraction as Claude's reading of it, so the whole proposal path can be walked
locally without a key. It is for local runs only; never set it in a deployment.

## Deploy

Railway, nixpacks — see `railway.toml` / `railway.json`. `npm run build`
produces `dist/public`; `npm run start` serves it through a small Express
process with a `/healthz` check.

The build command is `npm install`, not `npm ci`: Railway mounts a build cache
at `/app/node_modules/.cache`, and `npm ci` removes `node_modules` wholesale, so
it fails trying to `rmdir` that mount point with `EBUSY`.

Environment variables, all optional: `DATABASE_URL` (Postgres), `ADMIN_EMAIL`
and `ADMIN_CODE` for staff sign-in, `ANTHROPIC_API_KEY` (or `CLAUDE`) so uploaded
proposals are read and matched to groups, `DATA_DIR` for a writable volume when there is
no database, and `PORT` (defaults to 5000). Set the admin values in Railway
so the real credentials are not the ones committed here.
