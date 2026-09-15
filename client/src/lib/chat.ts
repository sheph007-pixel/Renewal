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

export interface ChatState {
  threads: ChatThread[];
  /** The group's standing preferences, as the assistant has them. */
  memory: MemoryLine[];
  /** True once the list has been fetched, so an empty list means "none" rather than "not yet". */
  loaded: boolean;
  messages: Record<number, ChatMessage[]>;
  streaming: Streaming | null;
  error: string | null;
}

let state: ChatState = { threads: [], memory: [], loaded: false, messages: {}, streaming: null, error: null };
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
  set({ threads: [], memory: [], loaded: false, messages: {}, streaming: null, error: null });
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

/**
 * Ask a question. On a new thread (`threadId` null) the server opens one and
 * says so first; `onThread` gets its id, so the caller can show it. Resolves
 * once the answer is complete; the thread list and messages update as the
 * reply streams in.
 */
export async function sendMessage(threadId: number | null, content: string, page: string, onThread?: (id: number) => void, compact = false, attachments: ChatFile[] = []): Promise<number> {
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
    body: JSON.stringify({ threadId: id, content, page, compact, attachments: attachments.map((f) => f.id) }),
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
