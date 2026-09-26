import { ANGLE_HEALTH_NO_PLAN_CAP, CIGNA_DIRECTORY, GRAVIE_SBC_URL, PLAN_LIMIT_CARRIERS, RATE_DISCLAIMER, groupSizeNote, planLimitSummary, type Group } from "@/lib/model";
import { C, h2, h3, panel } from "@/lib/ui";

/**
 * Disclaimers: the full text behind every "View Disclaimers" link, in one
 * format - a heading per section, then paragraphs, subheadings and bullets
 * at one size. Kennion is the broker; nothing here is legal, tax or coverage
 * advice. A Carrier/TPA's own terms are quoted as it wrote them.
 */
/** Plain text, text with a bold lead - "Gravie allows..." with "Gravie" bold - or text followed by one outbound link - "Network: Cigna OAP. [Cigna Provider Search]". */
type TextWithLink = string | { bold: string; text: string } | { text: string; linkLabel: string; linkUrl: string };
type Block = { h?: string; p?: TextWithLink; list?: TextWithLink[] };
type Section = { title: string; blocks: Block[] };

function Text({ t }: { t: TextWithLink }) {
  if (typeof t === "string") return <>{t}</>;
  if ("bold" in t) return (
    <>
      <strong style={{ color: C.ink }}>{t.bold}</strong>
      {t.text}
    </>
  );
  return (
    <>
      {t.text}{" "}
      <a href={t.linkUrl} target="_blank" rel="noreferrer" style={{ color: C.blue, fontWeight: 600, whiteSpace: "nowrap" }}>
        {t.linkLabel}
      </a>
    </>
  );
}

const GROUP_SIZE_FALLBACK =
  "Group size is based on the enrollment data on file for your group; tell us if your full-time equivalent count differs. At 50 or more full-time equivalent employees, the Affordable Care Act's employer mandate applies; under 50 it does not. The 50% starting point on the Medical Plans page is the Carrier/TPA's minimum contribution requirement, not an ACA affordability determination. The AI Assistant and your Kennion team can help you work through what applies before you decide.";

const ANGLE: Section = {
  title: "Angle Health Quotes",
  blocks: [
    { p: "Angle Health's quotes carry the following terms, as Angle Health states them." },
    {
      h: "Plan Information",
      list: [
        "Funding type: ERISA level-funded health plan.",
        "Accumulation period: calendar year.",
        "Plan administrator: Adrem Administrators LLC (a licensed subsidiary of Angle Health, Inc.).",
        "Stop loss insurer: Companion.",
        "12/24 contract: 12 months incurred, 24 months run out.",
      ],
    },
    {
      h: "Eligibility Requirements",
      list: [
        "Minimum enrollment: 2 employees (based on stop loss requirements).",
        "Minimum covered lives: 5 members.",
        "The number of COBRA participants may not exceed 10% of the group enrollment.",
        "The quote assumes retirees will not be covered.",
        "Rates are based on the submitted census at time of quote and subject to change with final enrollment.",
      ],
    },
    {
      h: "Other Requirements, Terms And Conditions",
      list: [
        "Adrem Administrators is the TPA.",
        "The quote assumes the group has a current Workers Compensation plan in place.",
        "Additional fees may be required due to Federal Health Care Reform. PCORI fees will be paid by the group.",
        "The proposal includes a $35 PEPM compensation fee.",
        "Angle Health does not administer COBRA, HSA or HRA. If the group requires these services, Angle Health can provide an EDI 834 or 837 file feed to the TPA of the group's choice.",
        "Rates are guaranteed for the 12-month contract period only.",
        "If enrollment differs by more than 10% during the contract or plan year, Angle reserves the right to reevaluate rates and plan designs, then adjust the rates from the audit date back to the effective date if there are any material changes to enrollment.",
      ],
    },
    {
      h: "Important",
      p: "The rates on the proposal are underwritten based on the information provided in the RFP or entered on the quoting platform. Rates are subject to final enrollment census check. Angle Health reserves the right to withdraw or modify the bid if any information provided changes, including but not limited to variations in census, claims data, demographics, or other factors affecting the risk profile of the group. Complete details on policy terms, administrative processes, and compliance requirements are thoroughly outlined in the Administrative Services Agreement and Stop Loss Policies, both of which are available upon request. Angle Health, Inc. is not a licensed insurance carrier, third-party administrator, or insurance producer. Adrem Administrators LLC, a subsidiary of Angle Health, Inc., is the third-party administrator for the plan. Stop loss policies are underwritten by Angle Insurance Services, Inc., a licensed insurance producer and subsidiary of Angle Health, Inc.",
    },
    {
      h: "Contract Documents",
      p: "All contract documents, including the Administrative Services Agreement and Stop Loss Policies, must be executed and returned within 30 days of Angle Health's delivery of the final documents to the group (the \"Execution Deadline\"). If the group fails to do so, Angle Health shall provide written notice. If the group is still non-compliant after 15 days from such notice, Angle Health may assess a late processing fee or withhold broker commission payments. Continued failure to return executed documents within 45 days of the Execution Deadline may result in suspension or termination of the group's plan arrangement.",
    },
    {
      p: "For the avoidance of doubt, the late processing fee is a separate administrative charge payable by the group and is not additional stop loss premium, TPA fees, or claims fund contributions. The group's total monthly invoice amount is used solely as the basis for calculating the liquidated damages amount.",
    },
  ],
};

const OPTIMYL: Section = {
  title: "Optimyl Health Quotes",
  blocks: [
    { p: "Optimyl Health's quotes carry the following terms, as Optimyl states them." },
    {
      h: "Plan Information",
      list: [
        "This is not an insured medical plan - it is a self-funded program for medical where I am the plan sponsor, plan administrator, and fiduciary. Stop Loss policies are underwritten by The North River Insurance Company or the Gerber Life Insurance Company.",
        "I have or will read the Summary Plan Document, Optimyl brochure, and the Stop Loss policy for details of coverage.",
      ],
    },
    {
      h: "Summary Plan Document Limitations",
      p: "The Summary Plan Document contains limitations, including but not limited to:",
      list: [
        "Inpatient Rehabilitation, Skilled Nursing Facility, and Subacute Rehab - 30 day limit, combined",
        "Outpatient Rehabilitation and Habilitative Services - 30 visit limit, combined",
        "Home Health - 45 day limit",
        "Hospice Care - 180 day limit",
        "Mental Health/Substance Abuse - 30 day limit Inpatient, 30 visit limit Outpatient, 50% coinsurance",
      ],
    },
    {
      h: "Summary Plan Document Exclusions",
      p: "The Summary Plan Document contains exclusions, including but not limited to:",
      list: [
        "Infertility Treatment",
        "Specialty drugs",
        "Care that is experimental, investigative, cosmetic, or otherwise not medically necessary",
        "Routine dental, vision, or hearing care, unless dental and vision are specifically elected",
        "Care to address quality of life or lifestyle concerns",
        "Alternative medicine",
        "Injuries caused by acts of war, commission of a felony, or under the influence of illegal substances",
        "Care that is covered by another payer, if applicable, such as Medicare or Worker's Compensation",
      ],
    },
    {
      h: "Other Requirements, Terms And Conditions",
      list: [
        "This program includes a closed formulary for prescription drugs through CVS. This formulary prioritizes generics, does not cover brand drugs not included on the formulary, and may assess a penalty if a brand is filled when a generic could have been substituted. See the formulary for details.",
        "This program includes utilization management services, which requires prior authorization for certain services and a penalty for access services without prior authorization, when required. See the Summary Plan Document for details.",
        "The following commissions specific to this case for your broker are built into the admin fees on this proposal: 7.0% of premium equivalent.",
        "Optimyl may have an agreement with your broker or a general agency under which either may be paid for the performance of administrative service and/or qualify for incentive payments based on new sales, block size, or retention. Any such payment is funded through Optimyl's general overhead.",
        "This proposal does not include certain Federal or State mandated fees, including but not limited to the PCORI assessment.",
        "This proposal presents benefits, rates, and an effective date for a given census that is not guaranteed until information is finalized and Optimyl approves the stop loss policy. Any existing coverage should remain in force until such written notification is received. If any of the provided information changes, Optimyl may change the rates, fees, or factors.",
        "The Proposal Summary page details whether 0%, 50%, or 100% of pharmacy rebates are distributed to you at the end of the plan year. If you terminate in the middle of the plan year, you forfeit these amounts. Further if the pharmacy rebate option indicates \"renewal req\" then you must renew for a subsequent plan year in order to be eligible for the prior year's rebates.",
        "The Proposal Summary page details whether a Delayed Admin Fee of 0% or 50% will be assessed against your claims fund refund before those funds are returned to you at the end of the year. If you terminate in the middle of the plan year, a Delayed Admin Fee of 100% will be assessed against your remaining claims fund and you will forfeit these amounts in full. Further, if the Delayed Admin Fee indicates \"renewal req\" then you must renew for a subsequent plan year in order to be eligible for the prior year's refund.",
        "This quote must be presented by a broker who is licensed in the state where the Stop Loss policy will be issued.",
        "The monthly payments and aggregate deductible in this proposal will adjust with changes in composition of my enrollment over time according to the tiered rates, fees, and factors.",
      ],
    },
    {
      h: "Important",
      p: "Underwriting information provided by or on behalf of the undersigned including any of the individual medical questionnaires completed by the employer's employees, are the undersigned's representations; that this Proposal and any Policy issued is in reliance upon the truth of such statements, declarations, and representations; and that such statements, declarations, and representations will form a part of the Stop Loss Insurance Policy. Any inaccuracy in such information or failure to disclose any such information, including all claims or possible claims, paid or pending, or which the employer or the employee's employees should otherwise know about, if discovered later, can result in rejection of this Application, or can change the terms, conditions, or the premiums rates, fees or factors, or can void coverage. I acknowledge that I have been advised that fraudulent statements or misrepresentation of material facts may result in retroactive termination of coverage and knowing and willful misstatements may represent a criminal violation of 18 US Code Section 1347.",
    },
    { p: "Please refer to the Program Management Services Agreement for full fee disclosures." },
  ],
};

const GRAVIE: Section = {
  title: "Gravie Quotes",
  blocks: [
    { p: "Gravie's quotes carry the following terms, as Gravie states them." },
    {
      h: "Quote Details",
      list: [
        "Effective date: January 1, 2027.",
        "Contract terms: Kennion's standard 12/24 (12 months incurred claims, 24 months run-out), with a 50% surplus return.",
        "Broker compensation: $35 PEPM.",
        { text: "Network: Cigna OAP.", linkLabel: "Cigna Provider Search", linkUrl: CIGNA_DIRECTORY },
        "Pharmacy benefit manager (PBM): ESI (Express Scripts).",
        "Every plan offered includes Teladoc, Sword Health and Gravie Pay.",
      ],
    },
    {
      h: "Contingencies",
      p: "Rates and plan designs are contingent on enrolled participation; Gravie may revisit them if actual participation differs from the quoted census by more than 10%.",
    },
    {
      p: { text: "Additional plan SBCs, for every network Gravie quotes, are on file with Gravie directly; be sure to open the one matching this group's network.", linkLabel: "View Gravie's SBCs", linkUrl: GRAVIE_SBC_URL },
    },
  ],
};

export default function Disclaimers({ g }: { g: Group }) {
  const sections: Section[] = [
    { title: "Rates And Benefits", blocks: [{ p: RATE_DISCLAIMER }] },
    { title: "Illustrative Quotes", blocks: [{ p: "Every rate shown on BenSync, on a plan card, in the grid, in a comparison or in a downloaded file, is an illustrative quote read from the Carrier/TPA's document or built from it. It is not a proposal, an offer or a guarantee of coverage. Benefits are shown as printed on the Carrier/TPA's quote; the plan documents issued at enrollment govern." }] },
    { title: "Employer Contribution", blocks: [{ p: "BenSync models a defined contribution: the employer sets a fixed monthly amount per coverage tier, and that amount goes toward whichever plan and tier each employee chooses. That is how the employer controls its spend, regardless of what plan or tier an employee picks; an employee who chooses a costlier plan pays the difference." }, { p: "Carriers and TPAs require minimum contributions of 50% of the employee cost. When more than one plan is offered, that requirement applies to the lowest-cost plan offered, and a richer plan is a buy-up the employee pays. If only one plan is offered, it applies to that plan. The Medical Plans page therefore starts every tier at 50% of the lowest-cost quoted plan's Employee Only rate and holds every tier to at least that; contributions toward spouses and children are the employer's choice. The Carrier/TPA applies its own rule at enrollment; confirm the contribution with your Kennion team before you decide." }] },
    {
      title: "How Many Plans A Group Can Offer",
      blocks: [
        { p: "Some Carriers/TPAs limit how many plans a group may offer its employees, based on enrolled headcount:" },
        {
          list: PLAN_LIMIT_CARRIERS.map((c) => planLimitSummary(c))
            .filter((s): s is { carrier: string; rest: string } => !!s)
            .map((s) => ({ bold: s.carrier, text: s.rest })),
        },
        { p: ANGLE_HEALTH_NO_PLAN_CAP },
      ],
    },
    { title: "Group Size And The Employer Mandate", blocks: [{ p: groupSizeNote(g) || GROUP_SIZE_FALLBACK }, { p: "BenSync does not determine whether a contribution or a plan is affordable or compliant under the Affordable Care Act. That determination is yours to make, with your Kennion team and your own advisors." }] },
    { title: "The AI Assistant And AI Picks", blocks: [{ p: "The AI Assistant and AI Picks work from the quotes, enrollment and census on file for your group. They can make mistakes. Their answers, picks and reasons are for discussion with your Kennion team, not advice, and nothing they say is an offer, a guarantee of coverage, or a legal, tax or compliance determination. Verify important information before you act on it." }] },
    ANGLE,
    OPTIMYL,
    GRAVIE,
    { title: "Kennion Benefit Advisors", blocks: [{ p: "Kennion Benefit Advisors is your broker. BenSync is the platform Kennion built to present the market's options for your group; coverage is issued by the Carrier/TPA you enroll with, on that Carrier/TPA's terms. Your Kennion account manager is the person to call with any question about what is shown here." }] },
  ];
  const section = { ...panel, padding: "18px 22px", marginBottom: 14 } as const;
  const text = { fontSize: 13.5, lineHeight: 1.65, color: C.body } as const;
  return (
    <div style={{ maxWidth: 860 }}>
      {sections.map((s) => (
        <section key={s.title} style={section}>
          <h2 style={{ ...h2, fontSize: 16 }}>{s.title}</h2>
          {s.blocks.map((b, i) => (
            <div key={i}>
              {b.h && <h3 style={{ ...h3, marginTop: 12, fontSize: 13.5 }}>{b.h}</h3>}
              {b.p && (
                <p style={{ ...text, margin: "6px 0 0" }}>
                  <Text t={b.p} />
                </p>
              )}
              {b.list && (
                <ul style={{ ...text, margin: "6px 0 0", paddingLeft: 20 }}>
                  {b.list.map((item) => (
                    <li key={typeof item === "string" ? item : item.text}>
                      <Text t={item} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
