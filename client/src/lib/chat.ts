import { useSyncExternalStore } from "react";
import { groupHeaders } from "@/lib/session";

/**
 * The assistant's conversations, held once for the whole app so the chat box
 * in the corner and the Assistant page are two views of the same threads: a
 * question asked from the corner shows up in the page's history, and a thread
 * opened on the page can be carried on from the corner.
 */
export interface ChatThread {
  id: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A document the assistant made for a turn: a comparison, a memo. */
export interface ChatFile {
  id: number;
  filename: string;
  mime: string;
  size: number;
  /** On the Documents tab: who put it there, which conversation, when. */
  role?: "user" | "assistant";
  threadId?: number | null;
  threadTitle?: string | null;
  createdAt?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  files?: ChatFile[];
  createdAt: string;
}

/** The reply being streamed: text so far, what is being built, documents made so far. */
export interface Streaming {
  threadId: number | null;
  text: string;
  status: string;
  files: ChatFile[];
}

/** One thing the assistant remembers about the group between conversations. */
export interface MemoryLine {
  id: number;
  text: string;
  source: "client" | "staff";
  createdAt: string;
}

/** One of the assistant's plan picks: a quoted 2027 option, and why. */
export interface RecommendedPick {
  carrier: string;
  /** The lineup's funding - UnitedHealthcare's two fundings each get their three picks. */
  funding?: string;
  slot?: string;
  tier: "lower_cost" | "best_fit" | "richer_benefits";
  optionId: string;
  plan: string;
  reason: string;
}

/** The assistant's plan recommendations for the group, as the Medical Plans page shows them. */
export interface Recommendations {
  summary: string;
  startWith: string | null;
  startWithReason: string;
  picks: RecommendedPick[];
  /** The conversation they were given in, to carry on from. */
  threadId: number | null;
  createdAt: string;
}

export interface ChatState {
  threads: ChatThread[];
  /** The assistant's plan picks: undefined until fetched, null when it has given none. */
  recommendations: Recommendations | null | undefined;
  /** The group's standing preferences, as the assistant has them. */
  memory: MemoryLine[];
  /** True once the list has been fetched, so an empty list means "none" rather than "not yet". */
  loaded: boolean;
  messages: Record<number, ChatMessage[]>;
  streaming: Streaming | null;
  error: string | null;
  /** Whether the corner chat box is open. */
  open: boolean;
  /** A question a page asked on the client's behalf: the box opens a new conversation and sends it. */
  pendingAsk: { question: string; title: string | null; threadId?: number | null } | null;
  /** A conversation a page asked the box to open, by id. */
  pendingThread: number | null;
}

/** Where the box remembers being open, per browser tab. */
const OPEN_KEY = "kennion.chat.open";
const rememberedOpen = () => {
  try {
    return sessionStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

let state: ChatState = { threads: [], recommendations: undefined, memory: [], loaded: false, messages: {}, streaming: null, error: null, open: rememberedOpen(), pendingAsk: null, pendingThread: null };
const listeners = new Set<() => void>();

function set(patch: Partial<ChatState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useChat(): ChatState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Sign-out: forget everything, so the next group in this tab starts clean. */
export function resetChat() {
  set({ threads: [], recommendations: undefined, memory: [], loaded: false, messages: {}, streaming: null, error: null, open: false, pendingAsk: null, pendingThread: null });
}

/** Open or close the corner chat box; remembered for this tab. */
export function setChatOpen(open: boolean) {
  try {
    sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage blocked: the box still opens for this page load.
  }
  set({ open });
}

/** The name of the conversation the Get Plan Recommendations button starts, and finds again. */
export const RECOMMENDATIONS_TITLE = "Plan recommendations";

/** The group's conversation of that name, if it has one. */
export function threadTitled(title: string): ChatThread | undefined {
  return state.threads.find((t) => (t.title || "").trim().toLowerCase() === title.toLowerCase());
}

/**
 * A question asked on the client's behalf - the Medical Plans page's "Get
 * Plan Recommendations" button. With a title, the conversation is made
 * once: the first press starts it under that name and sends the question;
 * a later press opens the same conversation again, recommendations and
 * all, rather than asking anew - unless `resend` is set, which asks the
 * question again in that same conversation. Without a title, a fresh
 * conversation.
 */
export async function askAssistant(question: string, title: string | null = null, resend = false) {
  if (title) {
    if (!state.loaded) await loadThreads().catch(() => undefined);
    const existing = threadTitled(title);
    if (existing) {
      if (resend) set({ pendingAsk: { question, title, threadId: existing.id }, pendingThread: null });
      else set({ pendingThread: existing.id, pendingAsk: null });
      setChatOpen(true);
      return;
    }
  }
  set({ pendingAsk: { question, title }, pendingThread: null });
  setChatOpen(true);
}

/**
 * Ask without opening the box - for the grid's AI Picks, which shows the
 * answer itself. Goes into the conversation of that name when there is one,
 * so the thread stays one; resolves when the answer is in (the picks arrive
 * on the stream as it runs).
 */
export async function askQuietly(question: string, title: string, page: string): Promise<void> {
  if (!state.loaded) await loadThreads().catch(() => undefined);
  const existing = threadTitled(title);
  await sendMessage(existing ? existing.id : null, question, page, undefined, false, [], existing ? null : title);
}

/** The assistant's plan picks for the group; null once fetched when it has given none. */
export async function loadRecommendations() {
  const r = await fetch("/api/chat/recommendations", { headers: groupHeaders() });
  if (r.ok) set({ recommendations: ((await r.json()) as { recommendations: Recommendations | null }).recommendations });
}

/** The box takes the pending question once it has sent it. */
export function takePendingAsk(): { question: string; title: string | null; threadId?: number | null } | null {
  const q = state.pendingAsk;
  if (q != null) set({ pendingAsk: null });
  return q;
}

/** The box takes the conversation it was asked to open. */
export function takePendingThread(): number | null {
  const id = state.pendingThread;
  if (id != null) set({ pendingThread: null });
  return id;
}

export async function loadMemory() {
  const r = await fetch("/api/chat/memory", { headers: groupHeaders() });
  if (r.ok) set({ memory: ((await r.json()) as { memory: MemoryLine[] }).memory });
}

/** Add a line the assistant should keep in mind from now on. */
export async function rememberMemory(text: string) {
  const r = await fetch("/api/chat/memory", { method: "POST", headers: { ...groupHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(await failure(r));
  set({ memory: ((await r.json()) as { memory: MemoryLine[] }).memory });
}

/** Drop one remembered line; the assistant no longer sees it. */
export async function forgetMemory(id: number) {
  const r = await fetch(`/api/chat/memory/${id}`, { method: "DELETE", headers: groupHeaders() });
  if (r.ok) set({ memory: ((await r.json()) as { memory: MemoryLine[] }).memory });
}

async function failure(r: Response): Promise<string> {
  const body = await r.json().catch(() => ({}));
  return (body as { error?: string }).error || `Request failed (${r.status})`;
}

export async function loadThreads() {
  const r = await fetch("/api/chat/threads", { headers: groupHeaders() });
  if (!r.ok) throw new Error(await failure(r));
  const p = (await r.json()) as { threads: ChatThread[] };
  set({ threads: p.threads, loaded: true });
}

export async function loadThread(id: number) {
  if (state.messages[id]) return;
  const r = await fetch(`/api/chat/threads/${id}`, { headers: groupHeaders() });
  if (!r.ok) throw new Error(await failure(r));
  const p = (await r.json()) as { thread: ChatThread; messages: ChatMessage[] };
  set({ messages: { ...state.messages, [id]: p.messages } });
}

export async function renameThread(id: number, title: string) {
  const r = await fetch(`/api/chat/threads/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...groupHeaders() },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(await failure(r));
  const p = (await r.json()) as { thread: ChatThread };
  set({ threads: state.threads.map((t) => (t.id === id ? p.thread : t)) });
}

export async function deleteThread(id: number) {
  const r = await fetch(`/api/chat/threads/${id}`, { method: "DELETE", headers: groupHeaders() });
  if (!r.ok) throw new Error(await failure(r));
  const messages = { ...state.messages };
  delete messages[id];
  set({ threads: state.threads.filter((t) => t.id !== id), messages });
}

/** Read `event:`/`data:` frames off the stream, one callback per frame. */
export async function readEvents(body: ReadableStream<Uint8Array>, on: (event: string, data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, at);
      buf = buf.slice(at + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      on(event, data.join("\n"));
    }
  }
}

const localId = () => -Math.floor(Math.random() * 1e9) - 1;

/** What a client may attach: the kinds the reader understands. */
export const ATTACHMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.csv,.docx,.txt";
export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;

/** Upload one attachment ahead of the message that will carry it. */
export async function uploadAttachment(file: File): Promise<ChatFile> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(`${file.name} is larger than 15 MB.`);
  const r = await fetch(`/api/chat/attachments?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", ...groupHeaders() },
    body: file,
  });
  if (!r.ok) throw new Error(await failure(r));
  return ((await r.json()) as { file: ChatFile }).file;
}

/** The group's documents, newest first: made by the assistant, attached to a question, or kept here. */
export async function loadFiles(): Promise<ChatFile[]> {
  const r = await fetch("/api/chat/files", { headers: groupHeaders() });
  if (!r.ok) throw new Error(await failure(r));
  return ((await r.json()) as { files: ChatFile[] }).files;
}

/** Keep a file in the Documents tab, outside any conversation. */
export async function uploadDocument(file: File): Promise<ChatFile> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(`${file.name} is larger than 15 MB.`);
  const r = await fetch(`/api/chat/files?filename=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", ...groupHeaders() },
    body: file,
  });
  if (!r.ok) throw new Error(await failure(r));
  return ((await r.json()) as { file: ChatFile }).file;
}

export async function deleteFile(id: number): Promise<void> {
  const r = await fetch(`/api/chat/files/${id}`, { method: "DELETE", headers: groupHeaders() });
  if (!r.ok) throw new Error(await failure(r));
  // The answer or question it hung on no longer lists it.
  const messages: Record<number, ChatMessage[]> = {};
  for (const [tid, list] of Object.entries(state.messages)) messages[Number(tid)] = list.map((m) => (m.files?.some((f) => f.id === id) ? { ...m, files: m.files.filter((f) => f.id !== id) } : m));
  set({ messages });
}

/** Fetch a file with the session headers and hand it to the browser as a download. */
/** Which grid view a file is of: the AI Picks report, or a comparison of the favorites, the comparison or every plan showing. */
export type ExportView = "picks" | "favorites" | "compare" | "all";

/**
 * What the Medical Plans grid is showing, as a PDF: the AI Picks view as the
 * picks report (the census, each pick's reason, the bills side by side); any
 * other view as a comparison of the plans showing. Saves through the browser.
 */
export async function exportGridPdf(view: ExportView, plans: string[], contribution: Record<string, number>, groupName: string): Promise<void> {
  const label = { picks: "AI Picks", favorites: "Favorites", compare: "Comparison", all: "Plans" }[view];
  await downloadFile("/api/group/export", `${groupName} - ${label}.pdf`, { view, plans, contribution });
}

/** Every 2027 plan's card as a row of an Excel workbook: the page builds the columns and rows, the server writes the file. */
export async function exportPlansExcel(columns: string[], rows: (string | number | null)[][], contribution: Record<string, number>, groupName: string): Promise<void> {
  await downloadFile("/api/group/export", `${groupName} - 2027 Medical Plans.xlsx`, { view: "all", format: "xlsx", columns, rows, contribution });
}

/** One employee on the census every rate is priced on: name, age, tier, plan and dependants' ages. Nothing else about anyone. */
export interface CensusMember {
  name: string;
  age: number | null;
  tier: "EE" | "ES" | "EC" | "FAM" | null;
  tierLabel: string | null;
  plan: string | null;
  spouseAges: number[];
  childAges: number[];
}

export async function loadCensus(): Promise<{ enrolled: number; members: CensusMember[] }> {
  const r = await fetch("/api/group/census", { headers: groupHeaders() });
  if (!r.ok) throw new Error(await failure(r));
  return (await r.json()) as { enrolled: number; members: CensusMember[] };
}

export function downloadCensusCsv(groupName: string): Promise<void> {
  return downloadFile("/api/group/census?format=csv", `${groupName} - Census.csv`);
}

/** One plan's card as a PDF: the page sends the card as it shows it, the server lays it out. */
export async function exportPlanCardPdf(card: unknown, title: string, groupName: string): Promise<void> {
  await downloadFile("/api/group/export", `${groupName} - ${title}.pdf`, { view: "all", format: "plan", card });
}

export async function downloadFile(url: string, filename: string, post?: unknown): Promise<void> {
  const r = await fetch(url, post === undefined ? { headers: groupHeaders() } : { method: "POST", headers: { ...groupHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(post) });
  if (!r.ok) throw new Error(await failure(r));
  const blob = await r.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/**
 * Ask a question. On a new thread (`threadId` null) the server opens one and
 * says so first; `onThread` gets its id, so the caller can show it. Resolves
 * once the answer is complete; the thread list and messages update as the
 * reply streams in.
 */
export async function sendMessage(threadId: number | null, content: string, page: string, onThread?: (id: number) => void, compact = false, attachments: ChatFile[] = [], title: string | null = null): Promise<number> {
  const question: ChatMessage = { id: localId(), role: "user", content, files: attachments, createdAt: new Date().toISOString() };
  let id = threadId;
  const fresh = (tid: number | null): Streaming => ({ threadId: tid, text: "", status: "", files: [] });
  if (id != null) {
    set({ messages: { ...state.messages, [id]: [...(state.messages[id] || []), question] }, streaming: fresh(id), error: null });
  } else {
    set({ streaming: fresh(null), error: null });
  }

  const r = await fetch("/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...groupHeaders() },
    body: JSON.stringify({ threadId: id, content, page, compact, attachments: attachments.map((f) => f.id), ...(title && id == null ? { title } : {}) }),
  });
  if (!r.ok || !r.body) {
    const error = await failure(r);
    set({ streaming: null, error });
    if (id != null) set({ messages: { ...state.messages, [id]: (state.messages[id] || []).filter((m) => m.id !== question.id) } });
    throw new Error(error);
  }

  let text = "";
  let status = "";
  const files: ChatFile[] = [];
  let error: string | null = null;
  const progress = () => set({ streaming: { threadId: id, text, status, files: [...files] } });
  await readEvents(r.body, (event, raw) => {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (event === "thread") {
      const t = data as { id: number; title: string | null };
      if (id == null) {
        id = t.id;
        const now = new Date().toISOString();
        const thread: ChatThread = { id: t.id, title: t.title, createdAt: now, updatedAt: now };
        set({
          threads: [thread, ...state.threads.filter((x) => x.id !== t.id)],
          messages: { ...state.messages, [t.id]: [question] },
          streaming: fresh(t.id),
        });
        onThread?.(t.id);
      }
    } else if (event === "text") {
      text += (data as { text: string }).text;
      progress();
    } else if (event === "status") {
      status = (data as { text: string }).text;
      progress();
    } else if (event === "file") {
      files.push((data as { file: ChatFile }).file);
      status = "";
      progress();
    } else if (event === "memory") {
      set({ memory: (data as { memory: MemoryLine[] }).memory });
    } else if (event === "recommendations") {
      set({ recommendations: (data as { recommendations: Recommendations }).recommendations });
    } else if (event === "done") {
      const m = (data as { message: ChatMessage }).message;
      const tid = id!;
      const now = new Date().toISOString();
      set({
        messages: { ...state.messages, [tid]: [...(state.messages[tid] || []), m] },
        threads: [...state.threads]
          .map((t) => (t.id === tid ? { ...t, updatedAt: now } : t))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
        streaming: null,
      });
    } else if (event === "error") {
      error = (data as { error: string }).error;
    }
  });
  if (error) {
    // Whatever streamed before the failure is kept on screen as a partial answer.
    const tid = id;
    if (tid != null && (text || files.length)) {
      const partial: ChatMessage = { id: localId(), role: "assistant", content: text, files, createdAt: new Date().toISOString() };
      set({ messages: { ...state.messages, [tid]: [...(state.messages[tid] || []), partial] } });
    }
    set({ streaming: null, error });
    throw new Error(error);
  }
  if (state.streaming) set({ streaming: null });
  return id!;
}
