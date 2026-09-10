import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { useWorld } from '@compound/koota-solid';
import { Computed, FrameRate, Name, Selected, Source, getActiveEntity } from '@compound/runtime';
import { classifyAuthFailure, threadAuthFailure, pendingThreadRequests, isWorking, t3ProjectId, thinkingDescriptor, thinkingValue, setThinkingValue, compatibleModelOptions } from '@compound/chat';
import type { ChatProject, ChatRequest, ChatState } from '@compound/chat';
import type { UploadChatAttachment, RuntimeMode, ProviderOptionSelections } from '@compound/chat/types';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { useProject } from '@/context/project';
import { flushProjectEdits } from '@/projects/edits';
import { ChatMarkdown } from './markdown';
import { ChatTranscript } from './transcript';
import { ChatApproval, ChatQuestion } from './requests';
import { ChatAuthNotice } from './auth-notice';
import { ChatPermissions } from './permissions';
import { ChatThinkingPicker } from './thinking-picker';
import { observeComposerLayout } from './composer-layout';
import { ChatModelPicker } from './model-picker';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';
import './chat.css';

const read = (key: string) => { try { return localStorage.getItem(`compound:chat:${key}`) || ''; } catch { return ''; } };
const write = (key: string, value: string) => { try { localStorage.setItem(`compound:chat:${key}`, value); } catch { /* private/storage-full mode */ } };
const providerLabel = (id: string) => id === 'claudeAgent' ? 'Claude Code' : 'Codex';
const call = (request: ChatRequest) => mainBridge.call(MAIN_CHANNELS.CHAT_REQUEST, request);

type PickerOption = { value: string; label: string };

function ChatPicker(props: { label: string; value: string; options: PickerOption[]; disabled?: boolean; placeholder?: string; onChange: (value: string) => void }) {
  return <Select<PickerOption>
    class="chat-picker"
    options={props.options}
    value={props.options.find(option => option.value === props.value) ?? null}
    optionValue="value"
    optionTextValue="label"
    disabled={props.disabled}
    placeholder={props.placeholder}
    onChange={option => { if (option) props.onChange(option.value); }}
    itemComponent={item => <SelectItem item={item.item}>{item.item.rawValue.label}</SelectItem>}
  >
    <SelectTrigger type="button" aria-label={props.label} title={props.options.find(option => option.value === props.value)?.label} class="chat-picker-trigger">
      <SelectValue<PickerOption>>{value => value.selectedOption().label}</SelectValue>
    </SelectTrigger>
    <SelectPortal><SelectContent /></SelectPortal>
  </Select>;
}

export function ChatPanel() {
  const project = useProject();
  const world = useWorld();
  const [state, setState] = createSignal<ChatState>({ status: 'starting', providers: [], shell: null, detail: null });
  const [selected, setSelected] = createSignal(read(`selected:${project.id()}`));
  const [provider, setProvider] = createSignal<'codex' | 'claudeAgent'>('codex');
  const [model, setModel] = createSignal('');
  const [draftOptions, setDraftOptions] = createSignal<{ key: string; options: ProviderOptionSelections }>();
  const savedPermissions = read(`permissions:${project.id()}`);
  const [draftPermissions, setDraftPermissions] = createSignal<RuntimeMode>(['approval-required', 'auto-accept-edits', 'auto', 'full-access'].includes(savedPermissions) ? savedPermissions as RuntimeMode : 'approval-required');
  const [changingPermissions, setChangingPermissions] = createSignal(false);
  const [draft, setDraft] = createSignal('');
  const [attachments, setAttachments] = createSignal<UploadChatAttachment[]>([]);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [checkingLogin, setCheckingLogin] = createSignal(false);
  const [loginError, setLoginError] = createSignal('');
  const [stick, setStick] = createSignal(true);
  const [pending, setPending] = createSignal<{ id: string; threadId: string; text: string }>();
  let viewport: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let composerFooter: HTMLDivElement | undefined;
  let disposed = false;
  let draftKey = '';
  let draftLoaded = false;
  let watchSerial = 0;
  const descriptor = (): ChatProject => ({ id: project.id(), name: project.name(), dir: project.dir() });
  const threads = createMemo(() => (state().shell?.threads ?? []).filter(t => t.projectId === t3ProjectId(project.id()) && !t.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  const thread = () => state().detail?.thread.id === selected() ? state().detail!.thread : undefined;
  const threadShell = () => threads().find(t => t.id === selected());
  const permissions = () => threadShell()?.runtimeMode ?? draftPermissions();
  const activeProviderId = () => threadShell()?.modelSelection.instanceId || provider();
  const activeProvider = createMemo(() => state().providers.find(p => p.instanceId === activeProviderId()));
  const savedModel = createMemo(() => threadShell()?.modelSelection.model);
  const models = () => activeProvider()?.models ?? [];
  const currentModel = () => models().find(candidate => candidate.slug === model());
  const thinking = createMemo(() => thinkingDescriptor(currentModel()));
  const optionsKey = () => `${selected()}:${activeProviderId()}:${model()}`;
  const modelOptions = createMemo(() => {
    const options = draftOptions()?.key === optionsKey() ? draftOptions()!.options : compatibleModelOptions(currentModel(), threadShell()?.modelSelection.options ?? []);
    const descriptor = thinking();
    const choice = descriptor && thinkingValue(descriptor, options);
    return descriptor && choice ? setThinkingValue(options, descriptor.id, choice.id) : options;
  });
  const working = () => isWorking(thread()) || isWorking(threadShell());
  const requests = createMemo(() => pendingThreadRequests(thread()), undefined, {
    equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
  });
  // Subscriptions depend on connection transitions, not every streamed state
  // update. Otherwise watching a thread would continually subscribe to itself.
  const ready = createMemo(() => state().status === 'ready');
  const authFailure = createMemo(() => threadAuthFailure(thread()) || classifyAuthFailure(error()) || classifyAuthFailure(state().error) || (activeProvider()?.auth.status === 'unauthenticated' ? 'required' as const : undefined));
  const sendBlocked = () => !ready() ? 'Waiting for chat server' : changingPermissions() ? 'Updating permissions' : checkingLogin() ? 'Checking login' : authFailure() ? 'Sign in to continue' : sending() ? 'Sending message' : working() ? 'Wait for this turn or press Stop' : !model() ? 'Choose a model' : !activeProvider()?.installed ? 'Install the provider first' : selected() && !thread() ? 'Loading conversation' : !draft().trim() && !attachments().length ? 'Write a message or attach an image' : '';
  const canSend = () => !sendBlocked();

  async function action(request: ChatRequest) {
    setError('');
    try { return await call(request); } catch (error) { setError((error as Error).message); throw error; }
  }
  const quietly = (request: ChatRequest) => { void action(request).catch(() => {}); };

  async function changePermissions(runtimeMode: RuntimeMode) {
    if (changingPermissions()) return;
    if (!selected()) { setDraftPermissions(runtimeMode); write(`permissions:${project.id()}`, runtimeMode); return; }
    setChangingPermissions(true);
    try { await action({ operation: 'permissions', threadId: selected(), runtimeMode }); }
    catch { /* action displays the error; keep the server's current mode. */ }
    finally { if (!disposed) setChangingPermissions(false); }
  }

  async function reconnectProvider() {
    if (checkingLogin()) return;
    const id = selected(), providerId = activeProviderId(), current = descriptor();
    setCheckingLogin(true); setLoginError('');
    try {
      const reply = await call({ operation: 'refresh', provider: providerId, cwd: current.dir });
      if (disposed || selected() !== id || activeProviderId() !== providerId) return;
      const refreshed = reply.state.providers.find(p => p.instanceId === providerId);
      if (refreshed?.auth.status !== 'authenticated') {
        setLoginError('Login could not be confirmed. Finish signing in in your terminal, then try again.');
        return;
      }
      setState(reply.state); setError('');
      // Claude's failed SDK session cannot be reused after reauthentication.
      // Preserve the old conversation and carry only the user's unsent draft.
      const text = draft(), images = attachments();
      write(`${current.id}:new`, text);
      setProvider(providerId as 'codex' | 'claudeAgent');
      setSelected('');
      setDraft(text); setAttachments(images);
    } catch {
      if (!disposed && selected() === id) setLoginError('Could not check your login. Please try again.');
    } finally { if (!disposed) setCheckingLogin(false); }
  }
  onMount(() => {
    if (composerFooter) onCleanup(observeComposerLayout(composerFooter));
    const unregister = mainBridge.handle(MAIN_CHANNELS.CHAT_STATE, setState);
    void call({ operation: 'state' }).then(reply => { if (!disposed) setState(reply.state); }).catch(error => setError(error.message));
    onCleanup(unregister);
  });
  onCleanup(() => { disposed = true; void call({ operation: 'unwatch' }).catch(() => {}); });

  createEffect(() => {
    const id = selected();
    write(`selected:${project.id()}`, id);
    draftKey = `${project.id()}:${id || 'new'}`;
    setDraft(read(draftKey)); draftLoaded = true;
    setAttachments([]); setError(''); setLoginError(''); setStick(true); setDraftOptions(undefined);
    if (!id) setModel('');
  });
  createEffect(() => { const value = draft(); if (draftLoaded) write(draftKey, value); });
  createEffect(() => {
    const current = activeProvider();
    const saved = savedModel();
    if (saved) setModel(saved);
    else if (current && !untrack(model)) setModel(current.models.find(m => m.isDefault)?.slug || current.models[0]?.slug || '');
  });
  createEffect(() => {
    const id = selected();
    if (!ready()) return;
    const serial = ++watchSerial;
    if (id) void call({ operation: 'watch', threadId: id }).catch(error => { if (serial === watchSerial && !disposed) setError(error.message); });
    else void call({ operation: 'unwatch' }).catch(() => {});
  });
  createEffect(() => {
    if (!ready()) return;
    const current = descriptor();
    void call({ operation: 'project', project: current }).catch(error => setError(error.message));
  });
  createEffect(() => {
    const messages = thread()?.messages;
    const optimistic = pending();
    if (optimistic && messages?.some(m => m.id === optimistic.id)) setPending(undefined);
    // Content height can change with tools as well as text deltas.
    thread()?.activities;
    if (stick()) requestAnimationFrame(() => { if (viewport) viewport.scrollTop = viewport.scrollHeight; });
  });

  function context(current: ChatProject) {
    const active = getActiveEntity(world);
    const fps = world.get(FrameRate)?.value || 30;
    return [
      'You are working in Compound, a local video composition editor.',
      `Project ID: ${current.id}\nProject name: ${current.name}\nProject directory: ${current.dir}`,
      `Read ${current.dir}/AGENTS.md and ${current.dir}/.compound/docs/reference/README.md. Authoring reference: ${current.dir}/.compound/docs/reference/jsx/README.md.`,
      'Edit this project’s files. Run compound commands with this directory as cwd, or pass --project with the project ID or absolute directory. compound projects list lists known projects.',
      'Your chat stays bound to this project if the user navigates elsewhere. compound context reports editorAttached. Capture, check and export require this exact project to be open; there is no background renderer. Do not open another project automatically.',
      `Editor context at send time: ${JSON.stringify({ activeScene: active?.get(Source)?.value ?? null, playheadSeconds: active ? (active.get(Computed)?.localTime ?? 0) / fps : null, selectedElements: [...world.query(Selected)].map(entity => ({ source: entity.get(Source)?.value, name: entity.get(Name)?.value })) })}`,
    ].join('\n\n');
  }

  async function send() {
    if (!canSend()) return;
    setSending(true); setError('');
    const current = descriptor(), text = draft().trim(), images = [...attachments()], selectedModel = model(), selectedOptions = modelOptions();
    const injected = context(current);
    const messageId = pending()?.threadId === selected() && pending()?.text === text ? pending()!.id : crypto.randomUUID();
    let id = selected();
    try {
      await flushProjectEdits(current.dir);
      if (!id) {
        const created = await call({ operation: 'create', project: current, provider: provider(), model: selectedModel, modelOptions: selectedOptions, runtimeMode: permissions() });
        id = created.threadId!;
        // Keep the unsent draft under the durable thread, including on errors.
        write(`${current.id}:${id}`, text);
        write(`${current.id}:new`, '');
        setSelected(id);
      }
      setPending({ id: messageId, threadId: id, text });
      await call({ operation: 'send', project: current, threadId: id, messageId, text, context: injected, model: selectedModel, modelOptions: selectedOptions, attachments: images });
      write(`${current.id}:${id}`, '');
      if (!disposed && selected() === id) { setDraft(''); setAttachments([]); setStick(true); }
    } catch (error) {
      if (!disposed) {
        setError((error as Error).message);
        if (selected() === id) setAttachments(images);
      }
    }
    finally { if (!disposed) setSending(false); }
  }

  async function addFiles(files: FileList | File[]) {
    try {
      const images: UploadChatAttachment[] = [];
      if (attachments().length + files.length > 8) throw new Error('Attach up to 8 images per message.');
      for (const file of Array.from(files)) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024) throw new Error('Use PNG, JPEG, WebP or GIF images up to 10 MB each.');
        const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = reject; reader.readAsDataURL(file); });
        images.push({ type: 'image', name: file.name, mimeType: file.type, sizeBytes: file.size, dataUrl });
      }
      setAttachments(previous => [...previous, ...images]);
    } catch (error) { setError((error as Error).message); }
  }

  return <section class="compound-chat" aria-label="Project chat">
    <div class="chat-toolbar">
      <ChatPicker label="Conversation" value={selected() || 'new'} placeholder="Conversation" options={[{ value: 'new', label: 'New chat' }, ...threads().map(t => ({ value: t.id, label: `${isWorking(t) ? '● ' : ''}${t.title}` }))]} onChange={value => setSelected(value === 'new' ? '' : value)} />
      <Button type="button" variant="secondary" size="icon-square" title="New chat" aria-label="New chat" onClick={() => { setSelected(''); }}><Icon name="plus-add" /></Button>
    </div>
    <Show when={!ready()}><div class="chat-status" role="status">{state().status === 'starting' ? 'Starting chat server…' : state().error || 'Chat is disconnected.'}<Show when={state().status === 'error' || state().status === 'stopped'}><button onClick={() => quietly({ operation: 'restart' })}>Retry</button></Show></div></Show>
    <Show when={ready() && !authFailure() && (!activeProvider()?.installed || !models().length)}>
      <div class="chat-status">{!activeProvider()?.installed ? `Install ${providerLabel(activeProviderId())} to start a chat.` : activeProvider()?.auth.status === 'unauthenticated' ? `Sign in with ${activeProviderId() === 'codex' ? 'codex login' : 'claude auth login'} in your terminal.` : 'Loading available models…'} <button onClick={() => quietly({ operation: 'refresh', provider: activeProviderId(), cwd: project.dir() })}>Refresh</button></div>
    </Show>
    <div class="chat-transcript" ref={viewport} onScroll={() => { if (viewport) setStick(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80); }}>
      <Show when={!selected()}><div class="chat-empty"><strong>Work on {project.name()}</strong><p>Ask Codex or Claude Code to edit your composition. This project and your current selection are included automatically.</p></div></Show>
      <Show when={selected() && !thread() && ready()}><p class="chat-status">Loading conversation…</p></Show>
      <Show when={thread()}>{current => <>
        <Show when={state().detail?.page?.hasMore}><button class="chat-load" onClick={() => quietly({ operation: 'older', threadId: current().id })}>Load earlier messages</button></Show>
        <ChatTranscript thread={current()} />
        <Show when={pending()?.threadId === current().id && !current().messages.some(m => m.id === pending()?.id)}><article class="chat-message chat-user"><p>{pending()?.text}</p><span class="chat-delivery-status">{sending() ? 'Sending…' : 'Awaiting confirmation'}</span></article></Show>

        <For each={current().proposedPlans}>{plan => <details class="chat-request" open><summary>Proposed plan</summary><ChatMarkdown threadId={current().id} text={plan.planMarkdown} /></details>}</For>
        {/* Keep form state while unrelated streaming events rebuild requests. */}
        <For each={requests().approvals.map(r => r.requestId)}>{id => <ChatApproval request={requests().approvals.find(r => r.requestId === id)!} threadId={current().id} send={action} />}</For>
        <For each={requests().userInputs.map(r => r.requestId)}>{id => <ChatQuestion request={requests().userInputs.find(r => r.requestId === id)!} threadId={current().id} send={action} />}</For>
        <Show when={working()}><p class="chat-working" role="status">Working…</p></Show>
        <Show when={current().session?.lastError && !classifyAuthFailure(current().session?.lastError)}><p class="chat-error" role="alert">{current().session?.lastError}</p></Show>
      </>}</Show>
    </div>
    <Show when={!stick()}><button class="chat-load" onClick={() => setStick(true)}>Jump to latest ↓</button></Show>
    <Show when={error() && !classifyAuthFailure(error()) || (ready() && state().error && !classifyAuthFailure(state().error))}><div class="chat-error" role="alert">{error() && !classifyAuthFailure(error()) ? error() : state().error}</div></Show>
    <Show when={ready() && authFailure()}>{failure => <ChatAuthNotice provider={activeProviderId()} failure={failure()} busy={checkingLogin()} error={loginError()} onReconnect={() => void reconnectProvider()} />}</Show>
    <form class="chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label="Message" placeholder={`Ask ${providerLabel(activeProviderId())}…`} value={draft()} onInput={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } }} onPaste={event => { const files = event.clipboardData?.files; if (files?.length) { event.preventDefault(); void addFiles(files); } }} />
      <Show when={attachments().length}><div class="chat-attachments"><For each={attachments()}>{(image, index) => <span><img src={image.dataUrl} alt={image.name} /><button type="button" aria-label={`Remove ${image.name}`} onClick={() => setAttachments(a => a.filter((_, i) => i !== index()))}>×</button></span>}</For></div></Show>
      <div ref={composerFooter} class="chat-composer-footer">
        <ChatModelPicker provider={activeProviderId()} model={model()} providers={state().providers} providerLocked={!!selected()} disabled={working() || sending()} onChange={(provider, model) => { setProvider(provider); setModel(model); }} />
        <Show when={thinking()}>{descriptor => <ChatThinkingPicker descriptor={descriptor()} options={modelOptions()} disabled={working() || sending()} onChange={value => setDraftOptions({ key: optionsKey(), options: setThinkingValue(modelOptions(), descriptor().id, value) })} />}</Show>
        <ChatPermissions value={permissions()} disabled={!ready() || sending() || changingPermissions()} onChange={value => void changePermissions(value)} />
        <span class="chat-composer-spacer" />
        <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={event => { if (event.currentTarget.files) void addFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
        <button class="chat-icon-button" type="button" title="Attach image" aria-label="Attach image" onClick={() => fileInput?.click()}><Icon name="attachment" /></button>
        <Show when={working()} fallback={<button class="chat-icon-button chat-send" type="submit" aria-label={sending() ? 'Sending message' : 'Send message'} title={sendBlocked() || 'Send message'} disabled={!canSend()}><Icon name={sending() ? 'spinner-loader' : 'arrow-right'} class={sending() ? 'animate-spin' : '-rotate-90'} /></button>}>
          <button type="button" class="chat-icon-button chat-send" aria-label="Stop response" title="Stop response" onClick={() => quietly({ operation: 'stop', threadId: selected() })}><span class="chat-stop-icon" aria-hidden="true" /></button>
        </Show>
      </div>
    </form>
  </section>;
}
