import { For, Show, createMemo, createResource, createSignal, type JSX } from 'solid-js';
import { marked, type Token, type Tokens } from 'marked';
import { mainBridge } from '@/lib/ipc';
import { MAIN_CHANNELS } from '@desktop/main-channels';

function externalUrl(path: string) {
  try { const url = new URL(path); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

export function ChatAsset(props: { threadId: string; path: string; image?: boolean; attachmentId?: string; mimeType?: string; label?: string }) {
  let retried = false;
  const [filePath, setFilePath] = createSignal<string>();
  const remote = () => externalUrl(props.path);
  const local = () => { try { return props.path.startsWith('file:') ? decodeURIComponent(new URL(props.path).pathname) : decodeURIComponent(props.path); } catch { return props.path; } };
  const supported = () => !/^[a-z][a-z0-9+.-]*:/i.test(props.path) || props.path.startsWith('file:') || !!remote();
  // Thread snapshots change during streaming. An unchanged asset must retain
  // its resource and media element across those updates.
  const assetKey = createMemo(() => supported() ? JSON.stringify([props.threadId, props.path, props.attachmentId, props.mimeType]) : false);
  const [asset, { refetch }] = createResource(assetKey, async () => {
    if (remote()) return remote();
    const result = await mainBridge.call(MAIN_CHANNELS.CHAT_REQUEST, { operation: 'asset', threadId: props.threadId, path: local(), ...(props.attachmentId ? { attachmentId: props.attachmentId } : {}), ...(props.mimeType ? { mimeType: props.mimeType } : {}) });
    setFilePath(result.filePath);
    return result.url;
  });
  const image = () => props.image || /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(props.path);
  const video = () => /\.(mp4|webm|mov)(?:[?#]|$)/i.test(props.path);
  const audio = () => /\.(mp3|m4a|wav|ogg)(?:[?#]|$)/i.test(props.path);
  const open = (event: MouseEvent) => { event.preventDefault(); const url = asset(); if (url) void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url }); };
  return <span class="chat-asset">
    <Show when={!asset.error} fallback={<button class="chat-link" onClick={() => void refetch()}>Retry {props.label || props.path}</button>}>
      <Show when={filePath()}><button class="chat-link" title="Show file in Finder" onClick={() => void mainBridge.call(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, { path: filePath()! })}>{props.label || props.path} ↗</button></Show>
      <Show when={!filePath()}><Show when={asset()} fallback={<span class="text-muted-foreground">{props.label || props.path}{asset.loading ? ' …' : ''}</span>}>
        {url => image() ? <img src={url()} alt={props.label || props.path} loading="lazy" onError={() => { if (!retried) { retried = true; void refetch(); } }} /> : video() ? <video controls preload="metadata" src={url()} /> : audio() ? <audio controls preload="metadata" src={url()} /> : <a href={url()} class="chat-link" onClick={open}>{props.label || props.path}</a>}
      </Show></Show>
    </Show>
  </span>;
}

/** Render Markdown as Solid elements. Provider HTML never enters innerHTML. */
export function ChatMarkdown(props: { text: string; threadId: string }) {
  const tokens = createMemo(() => marked.lexer(props.text));
  const inline = (tokens: Token[] | undefined, text = ''): JSX.Element => tokens ? <For each={tokens}>{token => render(token)}</For> : text;
  const render = (token: Token): JSX.Element => {
    switch (token.type) {
      case 'space': return null;
      case 'heading': return <div class="chat-heading">{inline((token as Tokens.Heading).tokens)}</div>;
      case 'paragraph': return <p>{inline((token as Tokens.Paragraph).tokens)}</p>;
      case 'text': { const t = token as Tokens.Text; return inline(t.tokens, t.text); }
      case 'strong': return <strong>{inline((token as Tokens.Strong).tokens)}</strong>;
      case 'em': return <em>{inline((token as Tokens.Em).tokens)}</em>;
      case 'del': return <del>{inline((token as Tokens.Del).tokens)}</del>;
      case 'codespan': return <code>{(token as Tokens.Codespan).text}</code>;
      case 'code': return <div class="chat-code"><button aria-label="Copy code" onClick={() => void navigator.clipboard.writeText((token as Tokens.Code).text)}>Copy</button><pre><code>{(token as Tokens.Code).text}</code></pre></div>;
      case 'br': return <br />;
      case 'hr': return <hr />;
      case 'blockquote': return <blockquote>{inline((token as Tokens.Blockquote).tokens)}</blockquote>;
      case 'list': { const list = token as Tokens.List; const items = <For each={list.items}>{item => <li><Show when={item.task}><input type="checkbox" checked={item.checked} disabled /></Show>{inline(item.tokens)}</li>}</For>; return list.ordered ? <ol start={list.start || 1}>{items}</ol> : <ul>{items}</ul>; }
      case 'table': { const table = token as Tokens.Table; return <div class="chat-table"><table><thead><tr><For each={table.header}>{cell => <th>{inline(cell.tokens)}</th>}</For></tr></thead><tbody><For each={table.rows}>{row => <tr><For each={row}>{cell => <td>{inline(cell.tokens)}</td>}</For></tr>}</For></tbody></table></div>; }
      case 'link': { const link = token as Tokens.Link; return <ChatAsset threadId={props.threadId} path={link.href} label={link.text} />; }
      case 'image': { const img = token as Tokens.Image; return <ChatAsset threadId={props.threadId} path={img.href} label={img.text} image />; }
      case 'escape': return (token as Tokens.Escape).text;
      // Raw HTML and unknown extensions stay inert text.
      default: return 'text' in token ? String(token.text) : token.raw;
    }
  };
  return <div class="chat-markdown"><For each={tokens()}>{render}</For></div>;
}
