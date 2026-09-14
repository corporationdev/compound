/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The chat state the UI renders, at module level so it outlives any page.
// Compound's backend is the embedded T3 Code server in the desktop main
// process: main owns every connection and pushes one `ChatState` snapshot
// over `MAIN_CHANNELS.CHAT_STATE`, and the UI sends `CHAT_REQUEST` commands
// back. Everything T3 owns (chats, transcripts, questions, approvals) is a
// view here; what is ours alone is the draft per chat, which tab is up, which
// chat each project shows, and the model / permission / thinking choices a
// new chat starts with.

import { createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { toast } from "somoto";

import {
  buildItems,
  classifyAuthFailure,
  compatibleModelOptions,
  isWorking,
  pendingThreadRequests,
  setThinkingValue,
  t3ProjectId,
  threadAuthFailure,
  thinkingDescriptor,
  thinkingValue,
  type ChatAuthFailure,
  type ChatProject,
  type ChatRequest,
  type ChatState,
  type Item,
} from "@compound/chat";
import type {
  OrchestrationThreadDetailSnapshot,
  ProviderApprovalDecision,
  ProviderOptionSelections,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
  UploadChatAttachment,
} from "@compound/chat/types";
import { MAIN_CHANNELS } from "@desktop/main-channels";

import { store as settings } from "@/init";
import { mainBridge } from "@/lib/ipc";
import { createStoredSignal } from "@/lib/store";
import { projectRoute } from "@/hooks/use-project-route";
import type { ProjectInfo } from "@/projects";

import { attachmentFromPath, attachmentPaths, type Attachment } from "./attachments";

export type SidebarTab = "editor" | "chat";

/** The two agents Compound drives, under T3's provider instance ids. */
export type HarnessId = "claudeAgent" | "codex";
export type ModelRef = { harness: HarnessId; model: string };
export type HarnessStatus = "ready" | "not-installed" | "signed-out" | "error" | "checking";
export type HarnessInfo = {
  id: HarnessId;
  label: string;
  status: HarnessStatus;
  detail?: string;
  models: { id: string; label: string }[];
  defaultModel?: string;
};
/** The chat-list row: T3's thread shell, in the shape the menus want. */
export type ChatSummary = {
  id: string;
  projectId: string;
  title: string;
  harness: HarnessId;
  model: string;
  status: "idle" | "running" | "waiting";
  updatedAt: number;
};

/** Images pasted or picked (uploaded to T3) plus paths dropped (read in place). */
export type Draft = { text: string; attachments: Attachment[]; images: UploadChatAttachment[] };

export const HARNESSES: readonly HarnessId[] = ["claudeAgent", "codex"];
export const HARNESS_LABELS: Record<HarnessId, string> = { claudeAgent: "Claude Code", codex: "Codex" };
export const SIGN_IN_COMMAND: Record<HarnessId, string> = { claudeAgent: "claude auth login", codex: "codex login" };
const isHarness = (value: string): value is HarnessId => value === "claudeAgent" || value === "codex";

/** The draft key for a chat that does not exist yet. */
export const draftKey = (projectId: string, chatId: string | null): string => chatId ?? `new:${projectId}`;

const EMPTY_DRAFT: Draft = { text: "", attachments: [], images: [] };
export const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type State = {
  chat: ChatState;
  /** The last command failure, cleared by the next successful command. */
  error: string;
  drafts: Record<string, Draft>;
  /** The user item shown while a send is in flight, by draft key. */
  sending: Record<string, Item | null>;
  /** Sign-in re-check in progress, and what it reported. */
  checkingLogin: boolean;
  loginError: string;
  changingPermissions: boolean;
};

const [state, setState] = createStore<State>({
  chat: { status: "starting", providers: [], shell: null, detail: null },
  error: "",
  drafts: {},
  sending: {},
  checkingLogin: false,
  loginError: "",
  changingPermissions: false,
});

export { state as chatState };

// --- settings that persist ---------------------------------------------

const root = createRoot(() => {
  const [tab, setTab] = createStoredSignal(settings.define<SidebarTab>("rightSidebar.tab", "editor"));
  const [model, setModel] = createStoredSignal(settings.define<ModelRef | null>("agentChat.model", null));
  const [active, setActive] = createStoredSignal(settings.define<Record<string, string>>("agentChat.active", {}));
  const [modes, setModes] = createStoredSignal(settings.define<Record<string, RuntimeMode>>("agentChat.permissions", {}));
  const [efforts, setEfforts] = createStoredSignal(settings.define<Record<string, string>>("agentChat.thinking", {}));
  return { tab, setTab, model, setModel, active, setActive, modes, setModes, efforts, setEfforts };
});

/** Which tab the right sidebar shows; persists across sessions. */
export const sidebarTab = root.tab;
export const setSidebarTab = root.setTab;

/** The remembered model, whether or not its harness is currently ready. */
export const storedModel = root.model;
export const setStoredModel = root.setModel;

/** Sentinel for "the empty draft chat" in the per-project active map. */
const DRAFT = "";

const threadsOf = (projectId: string) =>
  (state.chat.shell?.threads ?? []).filter((thread) => thread.projectId === t3ProjectId(projectId) && !thread.archivedAt);

const summarize = (thread: { id: string; projectId: string; title: string; updatedAt: string; modelSelection: { instanceId: string; model: string }; session?: unknown; latestTurn?: unknown }): ChatSummary => {
  const detail = state.chat.detail?.thread.id === thread.id ? state.chat.detail.thread : undefined;
  const waiting = detail ? pendingThreadRequests(detail).userInputs.length > 0 || pendingThreadRequests(detail).approvals.length > 0 : false;
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    harness: isHarness(thread.modelSelection.instanceId) ? thread.modelSelection.instanceId : "codex",
    model: thread.modelSelection.model,
    status: waiting ? "waiting" : isWorking(thread as Parameters<typeof isWorking>[0]) ? "running" : "idle",
    updatedAt: Date.parse(thread.updatedAt) || 0,
  };
};

/** This project's chats, newest first. */
export function chatsOf(projectId: string): ChatSummary[] {
  return threadsOf(projectId).map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The chat a project's panel shows: the remembered one, else the newest, else a draft (null). */
export function activeChatId(projectId: string): string | null {
  const remembered = root.active()[projectId];
  if (remembered === DRAFT) return null;
  const chats = chatsOf(projectId);
  if (remembered && chats.some((chat) => chat.id === remembered)) return remembered;
  return chats[0]?.id ?? null;
}

export function setActiveChat(projectId: string, chatId: string | null): void {
  root.setActive({ ...root.active(), [projectId]: chatId ?? DRAFT });
}

// --- the bridge ---------------------------------------------------------

const call = (request: ChatRequest) => mainBridge.call(MAIN_CHANNELS.CHAT_REQUEST, request);

let connected = false;

/** Subscribes once; safe to call from anywhere the chat is about to be used. */
export function ensureConnected(): void {
  if (connected || !window.desktop) return;
  connected = true;
  mainBridge.handle(MAIN_CHANNELS.CHAT_STATE, (chat) => setState("chat", chat));
  void call({ operation: "state" })
    .then((reply) => setState("chat", reply.state))
    .catch((error: Error) => setState("error", error.message));
}

/** Runs a command, surfacing its failure in the panel rather than the console. */
async function action(request: ChatRequest) {
  setState("error", "");
  try {
    return await call(request);
  } catch (error) {
    setState("error", (error as Error).message);
    throw error;
  }
}

export const restart = (): void => void action({ operation: "restart" }).catch(() => {});

/** True once main has a live T3 connection. */
export const ready = (): boolean => state.chat.status === "ready";

// --- harnesses and models -----------------------------------------------

const providerOf = (harness: HarnessId): ServerProvider | undefined => state.chat.providers.find((provider) => provider.instanceId === harness);

const harnessStatus = (provider: ServerProvider | undefined): HarnessStatus => {
  if (!ready()) return "checking";
  if (!provider) return "checking";
  if (!provider.installed) return "not-installed";
  if (provider.auth.status === "unauthenticated") return "signed-out";
  if (!provider.models.length) return "checking";
  return "ready";
};

export function harnesses(): HarnessInfo[] {
  return HARNESSES.map((id) => {
    const provider = providerOf(id);
    const status = harnessStatus(provider);
    return {
      id,
      label: HARNESS_LABELS[id],
      status,
      ...(status === "signed-out" ? { detail: `Run ${SIGN_IN_COMMAND[id]}` } : provider?.message ? { detail: provider.message } : {}),
      models: (provider?.models ?? []).map((model) => ({ id: model.slug, label: model.name })),
      ...(provider?.models.find((model) => model.isDefault) ? { defaultModel: provider.models.find((model) => model.isDefault)!.slug } : {}),
    };
  });
}

export const readyHarnesses = (): HarnessInfo[] => harnesses().filter((harness) => harness.status === "ready");

/** Re-probes the installed agents against a project directory. */
export function refreshHarnesses(dir?: string): void {
  if (!ready()) return;
  void action({ operation: "refresh", ...(dir ? { cwd: dir } : {}) }).catch(() => {});
}

/** The model the composers send with: the remembered one if ready, else the first ready default. */
export function currentModel(): ModelRef | null {
  const available = readyHarnesses();
  const remembered = storedModel();
  if (remembered) {
    const harness = available.find((entry) => entry.id === remembered.harness);
    if (harness && harness.models.some((model) => model.id === remembered.model)) return remembered;
  }
  const first = available[0];
  if (!first) return null;
  const model = first.defaultModel ?? first.models[0]?.id;
  return model ? { harness: first.id, model } : null;
}

/** The label the pickers show for a model ref. */
export function modelLabel(ref: ModelRef | null): string {
  if (!ref) return "No agent available";
  return harnesses().find((entry) => entry.id === ref.harness)?.models.find((model) => model.id === ref.model)?.label ?? ref.model;
}

const modelOf = (ref: ModelRef | null): ServerProviderModel | undefined =>
  ref ? providerOf(ref.harness)?.models.find((model) => model.slug === ref.model) : undefined;

// --- thinking (reasoning effort) ----------------------------------------

const effortKey = (ref: ModelRef) => `${ref.harness}:${ref.model}`;

/** The levels this model advertises, or nothing when it has none to offer. */
export const thinkingOptions = (ref: ModelRef | null) => thinkingDescriptor(modelOf(ref));

/** The level a send will use: the chat's own, else what this model last used. */
export function thinkingChoice(ref: ModelRef | null) {
  const descriptor = thinkingOptions(ref);
  if (!descriptor || !ref) return undefined;
  const remembered = root.efforts()[effortKey(ref)];
  return thinkingValue(descriptor, remembered ? [{ id: descriptor.id, value: remembered }] : []);
}

export function setThinking(ref: ModelRef, value: string): void {
  root.setEfforts({ ...root.efforts(), [effortKey(ref)]: value });
}

function modelOptions(ref: ModelRef): ProviderOptionSelections {
  const base = compatibleModelOptions(modelOf(ref), []);
  const descriptor = thinkingOptions(ref);
  const choice = thinkingChoice(ref);
  return descriptor && choice ? setThinkingValue(base, descriptor.id, choice.id) : base;
}

// --- permissions ---------------------------------------------------------

const RUNTIME_MODES: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/** The chat's mode when it has one, else the project's remembered new-chat mode. */
export function permissionMode(projectId: string, chatId: string | null): RuntimeMode {
  const thread = chatId ? threadsOf(projectId).find((entry) => entry.id === chatId) : undefined;
  if (thread) return thread.runtimeMode;
  const remembered = root.modes()[projectId];
  return remembered && RUNTIME_MODES.includes(remembered) ? remembered : "approval-required";
}

export async function setPermissionMode(projectId: string, chatId: string | null, runtimeMode: RuntimeMode): Promise<void> {
  if (!chatId) {
    root.setModes({ ...root.modes(), [projectId]: runtimeMode });
    return;
  }
  setState("changingPermissions", true);
  try {
    await action({ operation: "permissions", threadId: chatId, runtimeMode });
  } catch {
    // `action` reports it; T3's current mode stays authoritative.
  } finally {
    setState("changingPermissions", false);
  }
}

// --- the open chat -------------------------------------------------------

let watching: string | null = null;

/** Watches a chat; its transcript lands in the store and stays current. */
export function openChat(chatId: string): void {
  ensureConnected();
  if (!ready() || watching === chatId) return;
  watching = chatId;
  void action({ operation: "watch", threadId: chatId }).catch(() => {
    if (watching === chatId) watching = null;
  });
}

export function closeChat(): void {
  if (watching === null) return;
  watching = null;
  void call({ operation: "unwatch" }).catch(() => {});
}

/** Tells main which project this window is on, so T3 knows its workspace root. */
export function useProjectDir(project: ChatProject): void {
  if (!ready()) return;
  void action({ operation: "project", project }).catch(() => {});
}

const detailOf = (chatId: string | null): OrchestrationThreadDetailSnapshot["thread"] | undefined =>
  chatId && state.chat.detail?.thread.id === chatId ? state.chat.detail.thread : undefined;

const NO_ITEMS: Item[] = [];

/** The items to render for a chat; empty until its snapshot lands. */
export function itemsOf(chatId: string | null): Item[] {
  const thread = detailOf(chatId);
  return thread ? buildItems(thread) : NO_ITEMS;
}

/** The summary as T3 last reported it. */
export function summaryOf(projectId: string, chatId: string | null): ChatSummary | null {
  if (!chatId) return null;
  return chatsOf(projectId).find((entry) => entry.id === chatId) ?? null;
}

/** The approval and question cards this chat is waiting on. */
export function pendingOf(chatId: string | null) {
  return pendingThreadRequests(detailOf(chatId));
}

export const hasOlderMessages = (chatId: string | null): boolean => !!detailOf(chatId) && !!state.chat.detail?.page?.hasMore;

export function loadOlder(chatId: string): void {
  void action({ operation: "older", threadId: chatId }).catch(() => {});
}

/** A turn is in flight (or a send has not been acknowledged yet). */
export const isRunning = (projectId: string, chatId: string | null): boolean => {
  const thread = detailOf(chatId);
  const summary = summaryOf(projectId, chatId);
  return !!thread && isWorking(thread) || summary?.status === "running" || !!state.sending[draftKey(projectId, chatId)];
};

/** The chat's own error, when it is not a sign-in problem with its own notice. */
export function chatError(chatId: string | null): string {
  const session = detailOf(chatId)?.session?.lastError ?? "";
  const failure = state.error || (ready() ? state.chat.error ?? "" : "");
  const message = failure || session;
  return message && !classifyAuthFailure(message) ? message : "";
}

/** Whether the panel must show the sign-in notice, and why. */
export function authFailure(projectId: string, chatId: string | null): ChatAuthFailure | undefined {
  const harness = harnessOf(projectId, chatId);
  return (
    threadAuthFailure(detailOf(chatId)) ||
    classifyAuthFailure(state.error) ||
    classifyAuthFailure(state.chat.error) ||
    (providerOf(harness)?.auth.status === "unauthenticated" ? ("required" as const) : undefined)
  );
}

export function harnessOf(projectId: string, chatId: string | null): HarnessId {
  return summaryOf(projectId, chatId)?.harness ?? currentModel()?.harness ?? "codex";
}

// --- drafts -------------------------------------------------------------

export const draft = (key: string): Draft => state.drafts[key] ?? EMPTY_DRAFT;

export function setDraftText(key: string, text: string): void {
  setState("drafts", key, { ...draft(key), text });
}

export function setDraftAttachments(key: string, attachments: Attachment[]): void {
  setState("drafts", key, { ...draft(key), attachments });
}

export function setDraftImages(key: string, images: UploadChatAttachment[]): void {
  setState("drafts", key, { ...draft(key), images });
}

export function clearDraft(key: string): void {
  setState("drafts", key, EMPTY_DRAFT);
}

/**
 * Reads picked or pasted images into the draft. Nothing is uploaded until the
 * message is sent; the limits are T3's own.
 */
export async function addImages(key: string, files: FileList | File[]): Promise<void> {
  const current = draft(key).images;
  const chosen = Array.from(files);
  try {
    if (current.length + chosen.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per message.`);
    const added: UploadChatAttachment[] = [];
    for (const file of chosen) {
      if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) throw new Error("Use PNG, JPEG, WebP or GIF images up to 10 MB each.");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.readAsDataURL(file);
      });
      added.push({ type: "image", name: file.name, mimeType: file.type, sizeBytes: file.size, dataUrl });
    }
    setDraftImages(key, [...current, ...added]);
  } catch (error) {
    setState("error", (error as Error).message);
  }
}

// --- actions ------------------------------------------------------------

export type SendOptions = {
  project: ChatProject;
  chatId: string | null;
  text: string;
  attachments: string[];
  images: UploadChatAttachment[];
  model: ModelRef;
  /** The editor context appended to this one message. */
  context: string;
  runtimeMode?: RuntimeMode;
};

/**
 * Sends a turn, creating the chat first when there is none. Resolves with the
 * chat id as soon as T3 accepted the turn. Dropped paths ride in the text: the
 * agent reads them where they are, nothing is copied.
 */
export async function send(options: SendOptions): Promise<string> {
  const key = draftKey(options.project.id, options.chatId);
  const body = options.attachments.length
    ? `${options.text}${options.text.trim() ? "\n\n" : ""}Attached files:\n${options.attachments.map((path) => `- ${path}`).join("\n")}`
    : options.text;
  const messageId = crypto.randomUUID();
  setState("sending", key, {
    id: `optimistic:${messageId}`,
    createdAt: new Date().toISOString(),
    kind: "user",
    text: body,
    ...(options.attachments.length ? { attachments: options.attachments } : {}),
  });
  let chatId = options.chatId;
  try {
    if (!chatId) {
      const created = await action({
        operation: "create",
        project: options.project,
        provider: options.model.harness,
        model: options.model.model,
        modelOptions: modelOptions(options.model),
        runtimeMode: options.runtimeMode ?? permissionMode(options.project.id, null),
      });
      chatId = created.threadId!;
      setActiveChat(options.project.id, chatId);
      openChat(chatId);
    }
    await action({
      operation: "send",
      project: options.project,
      threadId: chatId,
      messageId,
      text: body,
      context: options.context,
      model: options.model.model,
      modelOptions: modelOptions(options.model),
      attachments: options.images,
    });
    setState("sending", key, null);
    // A new chat's draft key changes with its id; clear the old one too.
    if (!options.chatId) setState("drafts", key, EMPTY_DRAFT);
    return chatId;
  } catch (error) {
    setState("sending", key, null);
    throw error;
  }
}

/** The optimistic user item for a draft key, or null. */
export const sendingItem = (key: string): Item | null => state.sending[key] ?? null;

export async function interrupt(chatId: string): Promise<void> {
  await action({ operation: "stop", threadId: chatId });
}

export async function respond(chatId: string, requestId: string, answers: Record<string, unknown>): Promise<void> {
  await action({ operation: "answer", threadId: chatId, requestId, answers });
}

export async function approve(chatId: string, requestId: string, decision: ProviderApprovalDecision): Promise<void> {
  await action({ operation: "approve", threadId: chatId, requestId, decision });
}

/** Archiving is T3's delete: the conversation stops being listed. */
export async function deleteChat(projectId: string, chatId: string): Promise<void> {
  await action({ operation: "archive", threadId: chatId });
  if (watching === chatId) closeChat();
  setState(produce((current) => {
    delete current.drafts[chatId];
    delete current.sending[chatId];
  }));
  if (root.active()[projectId] === chatId) setActiveChat(projectId, null);
}

/**
 * Re-checks a provider's login after the user signed in elsewhere. Claude's
 * failed SDK session cannot be reused, so the old conversation is preserved and
 * only the unsent draft carries into a fresh one.
 */
export async function reconnect(project: ChatProject, chatId: string | null): Promise<void> {
  if (state.checkingLogin) return;
  const harness = harnessOf(project.id, chatId);
  setState({ checkingLogin: true, loginError: "" });
  try {
    const reply = await call({ operation: "refresh", provider: harness, cwd: project.dir });
    setState("chat", reply.state);
    const refreshed = reply.state.providers.find((provider) => provider.instanceId === harness);
    if (refreshed?.auth.status !== "authenticated") {
      setState("loginError", "Login could not be confirmed. Finish signing in in your terminal, then try again.");
      return;
    }
    setState({ error: "", loginError: "" });
    const carried = draft(draftKey(project.id, chatId));
    setActiveChat(project.id, null);
    setState("drafts", draftKey(project.id, null), carried);
  } catch {
    setState("loginError", "Could not check your login. Please try again.");
  } finally {
    setState("checkingLogin", false);
  }
}

// --- home-view handoff ---------------------------------------------------

export type StartChatOptions = {
  project: ProjectInfo;
  text: string;
  attachments: string[];
  model: ModelRef;
};

/**
 * Starts a chat from the dashboard: sends the first turn, makes the new chat
 * the project's active one and opens the Chat tab, so the editor lands with
 * the reply already streaming. On failure the text survives as the project's
 * draft and the error is a toast; home navigates either way.
 */
export async function startChat(options: StartChatOptions): Promise<void> {
  const project: ChatProject = { id: options.project.id || options.project.name, name: options.project.displayName, dir: options.project.dir };
  setSidebarTab("chat");
  // The layout provider is not mounted on the dashboard, so its stored key
  // is written directly: the editor reads it when it mounts.
  settings.define<boolean>("layout.uiVisible", true).value = true;
  ensureConnected();
  try {
    useProjectDir(project);
    await send({
      project,
      chatId: null,
      text: options.text,
      attachments: options.attachments,
      images: [],
      model: options.model,
      context: `You are working in Compound, a local video composition editor.\n\nProject ID: ${project.id}\nProject name: ${project.name}\nProject directory: ${project.dir}`,
    });
  } catch (error) {
    setActiveChat(project.id, null);
    setState("drafts", draftKey(project.id, null), {
      text: options.text,
      attachments: options.attachments.map(attachmentFromPath),
      images: [],
    });
    toast.error("Could not start the chat", { description: (error as Error).message });
  }
}

/** The route a started chat lands on. */
export const chatRoute = (project: ProjectInfo): string => projectRoute(project.id || project.name);

export { attachmentPaths };

/** Sidebar width by tab: room for about 47 characters of 12 px text on the Chat tab. */
export const EDITOR_SIDEBAR_WIDTH = 264;
export const CHAT_SIDEBAR_WIDTH = 320;

export const rightSidebarWidth = (): number => (sidebarTab() === "chat" ? CHAT_SIDEBAR_WIDTH : EDITOR_SIDEBAR_WIDTH);

/** For the composer: why nothing can be sent right now, or null. */
export function blockedReason(): string | null {
  if (!window.desktop) return "Chat runs in the desktop app.";
  if (state.chat.status === "starting") return "Starting the chat server…";
  if (state.chat.status === "reconnecting") return "Reconnecting to the chat server…";
  if (state.chat.status === "error" || state.chat.status === "stopped") return "Chat is disconnected.";
  const probes = harnesses();
  if (probes.every((harness) => harness.status === "checking")) return "Looking for Claude Code and Codex…";
  if (!readyHarnesses().length) {
    const detail = probes.map((harness) => harness.detail).find(Boolean);
    return detail ? `No agent is ready. ${detail}.` : "Install Claude Code or Codex to chat.";
  }
  if (state.changingPermissions) return "Updating permissions…";
  if (state.checkingLogin) return "Checking your login…";
  return null;
}
