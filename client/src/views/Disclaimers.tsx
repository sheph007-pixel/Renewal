import { PLAN_LIMIT_CARRIERS, RATE_DISCLAIMER, groupSizeNote, planLimitSummary, type Group } from "@/lib/model";
import { C, h2, h3, panel } from "@/lib/ui";

/**
 * Disclaimers: the full text behind every "View Disclaimers" link, in one
 * format - a heading per section, then paragraphs, subheadings and bullets
 * at one size. Kennion is the broker; nothing here is legal, tax or coverage
 * advice. A Carrier/TPA's own terms are quoted as it wrote them.
 */
type Block = { h?: string; p?: string; list?: string[] };
type Section = { title: string; blocks: Block[] };

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
    { p: "Optimyl Benefits' quotes carry the following terms, as Optimyl states them." },
    {
      h: "Plan Information",
      list: [
        "This is not an insured medical plan - it is a self-funded program in which the employer is the plan sponsor, plan administrator and fiduciary.",
        "Stop Loss coverage is underwritten by The North River Insurance Company or Gerber Life Insurance Company, and may vary or be unavailable in some states.",
        "Prescription drugs run on a closed formulary through CVS, prioritizing generics; a non-formulary brand is not covered, and filling a brand when a generic could be substituted may carry a penalty.",
        "The program includes utilization management: certain services require prior authorization, and accessing them without it when required carries a penalty.",
      ],
    },
    {
      h: "Summary Plan Document Limitations",
      list: [
        "Inpatient Rehabilitation, Skilled Nursing Facility and Subacute Rehab: 30-day limit, combined.",
        "Outpatient Rehabilitation and Habilitative Services: 30-visit limit, combined.",
        "Home Health: 45-day limit.",
        "Hospice Care: 180-day limit.",
        "Mental Health / Substance Abuse: 30-day inpatient limit, 30-visit outpatient limit, 50% coinsurance.",
      ],
    },
    {
      h: "Summary Plan Document Exclusions",
      list: [
        "Infertility treatment and specialty drugs.",
        "Care that is experimental, investigative, cosmetic, or otherwise not medically necessary.",
        "Routine dental, vision or hearing care, unless specifically elected.",
        "Care to address quality-of-life or lifestyle concerns, and alternative medicine.",
        "Injuries caused by acts of war, commission of a felony, or under the influence of illegal substances.",
        "Care covered by another payer, such as Medicare or Workers' Compensation.",
      ],
    },
    {
      h: "Other Requirements, Terms And Conditions",
      list: [
        "This proposal does not include certain federal or state mandated fees, including the PCORI assessment.",
        "Benefits, rates and the effective date are not guaranteed until the census is finalized and Optimyl approves the Stop Loss policy; existing coverage should stay in force until written notice is received.",
        "Pharmacy rebates and any Delayed Admin Fee refund detailed on the proposal are forfeited in full if the group terminates mid-year, and may require renewing for a subsequent plan year to remain eligible.",
        "Monthly payments and the aggregate deductible adjust over time with changes in the enrollment's composition, per the proposal's tiered rates, fees and factors.",
        "The quote must be presented by a broker licensed in the state where the Stop Loss policy will be issued.",
      ],
    },
    {
      h: "Important",
      p: "Underwriting information provided by or on behalf of the employer, including any employee medical questionnaires, is relied on as truthful; an inaccuracy or a failure to disclose - including claims the employer or its employees should reasonably know about - can result in rejection of the application, a change to terms, conditions, rates, fees or factors, or void coverage. Fraudulent statements or misrepresentation of material facts may result in retroactive termination of coverage. Full fee disclosures are in the Program Management Services Agreement.",
    },
  ],
};

export default function Disclaimers({ g }: { g: Group }) {
  const sections: Section[] = [
    { title: "Rates And Benefits", blocks: [{ p: RATE_DISCLAIMER }] },
    { title: "Illustrative Quotes", blocks: [{ p: "Every 2027 rate shown on BenSync, on a plan card, in the grid, in a comparison or in a downloaded file, is an illustrative quote read from the Carrier/TPA's document or built from it. It is not a proposal, an offer or a guarantee of coverage. Benefits are shown as printed on the Carrier/TPA's quote; the plan documents issued at enrollment govern." }] },
    { title: "Employer Contribution", blocks: [{ p: "BenSync models a defined contribution: the employer sets a fixed monthly amount per coverage tier, and that amount goes toward whichever plan and tier each employee chooses. That is how the employer controls its spend, regardless of what plan or tier an employee picks; an employee who chooses a costlier plan pays the difference." }, { p: "Carriers and TPAs require minimum contributions of 50% of the employee cost. When more than one plan is offered, that requirement applies to the lowest-cost plan offered, and a richer plan is a buy-up the employee pays. If only one plan is offered, it applies to that plan. The Medical Plans page therefore starts every tier at 50% of the lowest-cost quoted plan's Employee Only rate and holds every tier to at least that; contributions toward spouses and children are the employer's choice. The Carrier/TPA applies its own rule at enrollment; confirm the contribution with your Kennion team before you decide." }] },
    {
      title: "How Many Plans A Group Can Offer",
      blocks: [
        { p: "Some Carriers/TPAs limit how many plans a group may offer its employees, based on enrolled headcount:" },
        { list: PLAN_LIMIT_CARRIERS.map((c) => planLimitSummary(c)).filter((s): s is string => !!s) },
        { p: "A Carrier/TPA not named here has no plan-count limit on file. Confirm your group's own limit, and whether asking underwriting for an additional plan is worth pursuing, with your Kennion team." },
      ],
    },
    { title: "Group Size And The Employer Mandate", blocks: [{ p: groupSizeNote(g) || GROUP_SIZE_FALLBACK }, { p: "BenSync does not determine whether a contribution or a plan is affordable or compliant under the Affordable Care Act. That determination is yours to make, with your Kennion team and your own advisors." }] },
    { title: "The AI Assistant And AI Picks", blocks: [{ p: "The AI Assistant and AI Picks work from the quotes, enrollment and census on file for your group. They can make mistakes. Their answers, picks and reasons are for discussion with your Kennion team, not advice, and nothing they say is an offer, a guarantee of coverage, or a legal, tax or compliance determination. Verify important information before you act on it." }] },
    ANGLE,
    OPTIMYL,
    { title: "Kennion Benefit Advisors", blocks: [{ p: "Kennion Benefit Advisors is your broker. BenSync is the platform Kennion built to present the market's options for your renewal; coverage is issued by the Carrier/TPA you enroll with, on that Carrier/TPA's terms. Your Kennion account manager is the person to call with any question about what is shown here." }] },
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
              {b.p && <p style={{ ...text, margin: "6px 0 0" }}>{b.p}</p>}
              {b.list && (
                <ul style={{ ...text, margin: "6px 0 0", paddingLeft: 20 }}>
                  {b.list.map((item) => (
                    <li key={item}>{item}</li>
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
