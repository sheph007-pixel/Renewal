// A carrier's own Summary of Benefits and Coverage (SBC) and Summary of
// Benefits (SOB) for each standard plan design - the document itself, not
// just the figures read off it (server/plan-catalogue.js). One PDF per plan
// code and doc type; Angle Health names them
// ANG_<FAMILY>_<deductible>_<oop>_<id>_<SBC|SOB>.pdf (the Value plans carry
// one figure, not two, since their deductible and OOP max are the same
// number: ANG_VALUE_<amount>_<id>_<SBC|SOB>.pdf). The <id> is Angle Health's
// own document number and is dropped - what identifies a document here is
// the plan code it shares with the catalogue, so a quoted plan's design and
// its documents are found the same way.
import fs from "fs";
import path from "path";

/** "ANG_TRAD_5000_7000_360645_SBC.pdf" -> { planCode: "ANG TRAD 5000 7000", docType: "SBC" }; null for a name that isn't this shape. */
export function parseDocFilename(filename) {
  const base = String(filename || "").replace(/\.pdf$/i, "");
  const parts = base.split("_").filter(Boolean);
  if (parts.length < 3) return null;
  const docType = parts[parts.length - 1].toUpperCase();
  if (docType !== "SBC" && docType !== "SOB") return null;
  const planCode = parts.slice(0, -2).join(" ");
  return planCode ? { planCode, docType } : null;
}

/**
 * Every SBC/SOB shipped for a carrier: every *.pdf directly under `dir`,
 * matched by filename. A missing directory is empty, not an error, so a
 * carrier with no documents on file yet does not stop the others loading.
 */
export function loadPlanDocumentFiles(dir, { carrier, planYear = 2027 }) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /\.pdf$/i.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const filename of names) {
    const parsed = parseDocFilename(filename);
    if (!parsed) continue;
    out.push({
      carrier,
      planYear,
      planCode: parsed.planCode,
      docType: parsed.docType,
      filename,
      mime: "application/pdf",
      data: fs.readFileSync(path.join(dir, filename)),
      source: filename,
    });
  }
  return out;
}
