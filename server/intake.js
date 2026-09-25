// Opens whatever lands in the proposals drop zone.
//
// A carrier proposal can arrive as a PDF, a spreadsheet, a Word file, a
// picture of a rate sheet, a CSV - or as an email with any of those attached.
// This module turns one upload into the pieces worth reading: an email is
// split into its attachments (with the email's subject, sender and body kept
// as context for the match), and each piece is converted into something the
// model can take directly: the PDF or image itself, or extracted text.
import path from "node:path";
import { simpleParser } from "mailparser";
import * as msgreader from "@kenjiuno/msgreader";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const MsgReader = msgreader.default?.default || msgreader.default || msgreader.MsgReader;

const BY_EXT = {
  ".pdf": ["pdf", "application/pdf"],
  ".png": ["image", "image/png"],
  ".jpg": ["image", "image/jpeg"],
  ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"],
  ".webp": ["image", "image/webp"],
  ".xlsx": ["sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".xlsm": ["sheet", "application/vnd.ms-excel.sheet.macroEnabled.12"],
  ".xls": ["sheet", "application/vnd.ms-excel"],
  ".csv": ["text", "text/csv"],
  ".txt": ["text", "text/plain"],
  ".docx": ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".eml": ["email", "message/rfc822"],
  ".msg": ["msg", "application/vnd.ms-outlook"],
  ".zip": ["zip", "application/zip"],
};
const BY_MIME = {
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "text/csv": "text",
  "text/plain": "text",
  "message/rfc822": "email",
  "application/vnd.ms-outlook": "msg",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "sheet",
  "application/vnd.ms-excel": "sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-zip": "zip",
};

/** What a file is, from its name first and its declared type second. */
export function classify(filename, mime) {
  const ext = path.extname(filename || "").toLowerCase();
  if (BY_EXT[ext]) return { type: BY_EXT[ext][0], mime: BY_EXT[ext][1] };
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  if (BY_MIME[m]) return { type: BY_MIME[m], mime: m };
  return { type: "unsupported", mime: m || "application/octet-stream" };
}

export const SUPPORTED =
  "PDF, email (.eml or .msg), a .zip of any of these, Excel, Word, CSV, text, or an image (PNG, JPG)";

/** Images under this size are logos and signatures, not rate sheets. */
const MIN_IMAGE_BYTES = 30 * 1024;

const excerpt = (s, n = 4000) => {
  const t = String(s || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? t.slice(0, n) + " …" : t;
};

/**
 * Open a .zip into the files worth reading. Folders, macOS junk
 * (__MACOSX, .DS_Store) and anything unsupported (a nested .zip included -
 * one level is enough) are left out and listed in `skipped`, the same as an
 * email attachment this does not read.
 */
async function openZip(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const items = [];
  const skipped = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const base = entry.name.split("/").pop();
    if (!base || entry.name.includes("__MACOSX/") || base.startsWith(".")) continue;
    const c = classify(base, "");
    if (c.type === "unsupported" || c.type === "zip") {
      skipped.push(`${base} (not a type this reads)`);
      continue;
    }
    const buf = await entry.async("nodebuffer");
    if (c.type === "image" && buf.length < MIN_IMAGE_BYTES) {
      skipped.push(`${base} (small image, likely a logo)`);
      continue;
    }
    items.push({ filename: base, mime: c.mime, buffer: buf });
  }
  return { items, skipped };
}

/** Open an .eml or .msg into { context, attachments }. */
async function openEmail(buffer, type) {
  if (type === "email") {
    const m = await simpleParser(buffer);
    const attachments = (m.attachments || [])
      .filter((a) => !a.related) // inline images referenced by the HTML body
      .map((a) => ({
        filename: a.filename || "attachment",
        mime: a.contentType || "",
        buffer: Buffer.from(a.content),
      }));
    return {
      context: {
        subject: m.subject || "",
        from: m.from?.text || "",
        to: m.to?.text || "",
        date: m.date ? new Date(m.date).toISOString() : null,
        body: excerpt(m.text || (m.html ? String(m.html).replace(/<[^>]+>/g, " ") : "")),
      },
      attachments,
    };
  }
  // Outlook .msg
  const reader = new MsgReader(buffer);
  const data = reader.getFileData();
  const attachments = [];
  for (const att of data.attachments || []) {
    try {
      const got = reader.getAttachment(att);
      if (!got || !got.content) continue;
      attachments.push({
        filename: att.fileName || att.name || got.fileName || "attachment",
        mime: att.attachMimeTag || "",
        buffer: Buffer.from(got.content),
      });
    } catch {
      // A broken attachment record should not lose the rest of the email.
    }
  }
  const from = [data.senderName, data.senderEmail].filter(Boolean).join(" ");
  return {
    context: {
      subject: data.subject || "",
      from: from || data.senderSmtpAddress || "",
      to: (data.recipients || []).map((r) => r.name || r.email).filter(Boolean).join(", "),
      date: data.messageDeliveryTime || data.clientSubmitTime || null,
      body: excerpt(data.body || ""),
    },
    attachments,
  };
}

/**
 * Turn one upload into what should be stored and read.
 *
 *   { email: null,   items: [file] }                     a plain file
 *   { email: {...},  items: [attachment, ...] }          an email with attachments
 *   { email: {...},  items: [],  bodyOnly: true }        an email whose body is the proposal
 *
 * Every item is { filename, mime, buffer, kind, context? }. Unsupported
 * attachments (a .zip, a tiny logo) are listed in `skipped` rather than failing.
 */
export async function expandUpload({ buffer, mime, filename }) {
  const c = classify(filename, mime);
  if (c.type === "unsupported") {
    throw new Error(`"${filename}" is not a type this reads yet. Upload ${SUPPORTED}.`);
  }
  if (c.type === "zip") {
    const { items, skipped } = await openZip(buffer);
    if (!items.length) throw new Error(`"${filename}" has nothing this reads. Upload ${SUPPORTED}.`);
    return { email: null, items: items.map((it) => ({ ...it, kind: "attachment" })), skipped };
  }
  if (c.type !== "email" && c.type !== "msg") {
    return { email: null, items: [{ filename, mime: c.mime, buffer, kind: "file" }], skipped: [] };
  }

  const opened = await openEmail(buffer, c.type);
  const context = { ...opened.context, emailFilename: filename };
  const items = [];
  const skipped = [];
  for (const a of opened.attachments) {
    const ac = classify(a.filename, a.mime);
    if (ac.type === "zip") {
      const nested = await openZip(a.buffer);
      for (const it of nested.items) items.push({ filename: it.filename, mime: it.mime, buffer: it.buffer, kind: "attachment", context });
      skipped.push(...nested.skipped);
      continue;
    }
    if (ac.type === "unsupported" || ac.type === "email" || ac.type === "msg") {
      skipped.push(`${a.filename} (not a type this reads)`);
      continue;
    }
    if (ac.type === "image" && a.buffer.length < MIN_IMAGE_BYTES) {
      skipped.push(`${a.filename} (small image, likely a logo)`);
      continue;
    }
    items.push({ filename: a.filename, mime: ac.mime, buffer: a.buffer, kind: "attachment", context });
  }
  const email = { filename, mime: c.mime, buffer, kind: "email", context };
  return { email, items, skipped, bodyOnly: items.length === 0 };
}

/** Spreadsheet → CSV text, one block per sheet. */
function sheetToText(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false });
    if (csv.trim()) parts.push(`## Sheet: ${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

/** Word document → plain text, paragraph per line. */
async function docxToText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) return "";
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_TEXT = 300_000;
const capped = (text) => ({ kind: "text", text: text.slice(0, MAX_TEXT), ...(text.length > MAX_TEXT ? { truncated: true } : {}) });

/**
 * What the model gets for one item:
 *   { kind: "pdf", buffer } | { kind: "image", mime, buffer } | { kind: "text", text }
 */
export async function prepareForModel(item) {
  const c = classify(item.filename, item.mime);
  switch (c.type) {
    case "pdf":
      return { kind: "pdf", buffer: item.buffer };
    case "image":
      return { kind: "image", mime: c.mime, buffer: item.buffer };
    // Text past MAX_TEXT is cut - and the cut is said out loud (`truncated`),
    // so the reading carries a flag rather than silently missing plans.
    case "sheet":
      return capped(sheetToText(item.buffer));
    case "docx":
      return capped(await docxToText(item.buffer));
    case "text":
      return capped(item.buffer.toString("utf8"));
    case "email":
    case "msg": {
      // The email body is the proposal (no attachments worth reading).
      const opened = await openEmail(item.buffer, c.type);
      const h = opened.context;
      return {
        kind: "text",
        text: `From: ${h.from}\nTo: ${h.to}\nDate: ${h.date || ""}\nSubject: ${h.subject}\n\n${h.body}`,
      };
    }
    default:
      throw new Error(`"${item.filename}" is not a type this reads yet.`);
  }
}
