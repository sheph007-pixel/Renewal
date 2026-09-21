// Reads a piece of marketing material - a broker deck, a one-pager, an FAQ -
// and says which vendor it is for and what to call it, so the Resources page
// can file it under that vendor's section the moment it is uploaded. Same
// reading pattern as server/ai.js's proposal reader: Claude reads the
// document itself, structured output, nothing here is authoritative (staff
// can correct the vendor or title after the fact).
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

const apiKey = () =>
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.CLAUDE || "";
const fakeAi = () => process.env.KENNION_FAKE_AI === "1";
export const resourceReaderEnabled = () => !!(apiKey() || process.env.ANTHROPIC_AUTH_TOKEN || fakeAi());

const MODEL = "claude-opus-5";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["carrier", "title", "summary"],
  properties: {
    carrier: {
      type: "string",
      description:
        "The Carrier/TPA or vendor this material is about or from, exactly as Kennion names them: UnitedHealthcare, Gravie, Nationwide, Angle Health, Cobalt, Optimyl Health, EBPA, HealthEZ, BCBS of Alabama, Guardian, VSP. 'Other' if it plainly names none of these, or a general Kennion piece not about one vendor.",
    },
    title: {
      type: "string",
      description: "A short, plain title for this piece as an employer would read it on a resources page - what the document itself is called, not a summary. Under 60 characters.",
    },
    summary: {
      type: "string",
      description: "One short sentence on what this material covers, for a caption under the title.",
    },
  },
};

const SYSTEM = `You read marketing and reference material for Kennion Benefit Advisors, a benefits brokerage, to file it on the client-facing Resources page under the right vendor's section: broker decks, one-page overviews, FAQs, plan-family brochures and the like - never a rate quote or a carrier's own SBC (those are read and filed elsewhere). Say which Carrier/TPA or vendor it is about, give it a short title an employer would recognize on a resources page, and one sentence on what it covers.`;

/** A canned reading for local runs with no Anthropic key (KENNION_FAKE_AI=1). */
function fakeReading(filename) {
  return { carrier: "Other", title: filename.replace(/\.[a-z0-9]+$/i, ""), summary: "Canned reading (KENNION_FAKE_AI)." };
}

/**
 * Categorize one uploaded resource. `file` is { filename, prepared } where
 * `prepared` came from intake.prepareForModel. Returns { carrier, title,
 * summary }, or throws with a message the admin screen can show.
 */
export async function categorizeResource(file) {
  if (fakeAi()) return fakeReading(file.filename);
  if (!resourceReaderEnabled()) throw new Error("AI reading is off: no ANTHROPIC_API_KEY is set.");
  const client = apiKey() ? new Anthropic({ apiKey: apiKey() }) : new Anthropic();

  const content = [];
  const p = file.prepared;
  if (p.kind === "pdf") {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.buffer.toString("base64") }, title: file.filename });
  } else if (p.kind === "image") {
    content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.buffer.toString("base64") } });
  } else {
    content.push({ type: "document", source: { type: "text", media_type: "text/plain", data: p.text || "(empty)" }, title: file.filename });
  }
  content.push({ type: "text", text: `The file is named "${file.filename}". Read it and fill in the structured result.` });

  const params = {
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM }],
    output_config: { effort: "low", format: jsonSchemaOutputFormat(SCHEMA) },
    messages: [{ role: "user", content }],
  };
  const response = await client.messages.stream(params).finalMessage();
  if (response.stop_reason === "refusal") throw new Error("The model declined to read this document.");
  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new Error("Could not read a structured result from the document.");
  }
  if (!out || typeof out !== "object") throw new Error("Could not read a structured result from the document.");
  return out;
}
