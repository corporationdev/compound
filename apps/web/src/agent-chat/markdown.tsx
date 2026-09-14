/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Assistant text as Markdown: `marked` for the parse, Solid elements for the
// render. Provider HTML never reaches innerHTML, so there is nothing to
// sanitise. Links and images resolve through T3's signed asset URLs, and a
// file that is not previewable is a Reveal action — rendering a link must
// never open a program.

import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { marked, type Token, type Tokens } from "marked";

import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";

function externalUrl(path: string) {
  try {
    const url = new URL(path);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

type AssetProps = {
  threadId: string;
  path: string;
  image?: boolean;
  attachmentId?: string;
  mimeType?: string;
  label?: string;
};

/** One referenced file: an inline preview, a link, or a Reveal button. */
export function ChatAsset(props: AssetProps) {
  let retried = false;
  const [filePath, setFilePath] = createSignal<string>();
  const remote = () => externalUrl(props.path);
  const local = () => {
    try {
      return props.path.startsWith("file:") ? decodeURIComponent(new URL(props.path).pathname) : decodeURIComponent(props.path);
    } catch {
      return props.path;
    }
  };
  const supported = () => !/^[a-z][a-z0-9+.-]*:/i.test(props.path) || props.path.startsWith("file:") || !!remote();
  // Thread snapshots change during streaming. An unchanged asset must retain
  // its resource and media element across those updates.
  const assetKey = createMemo(() => (supported() ? JSON.stringify([props.threadId, props.path, props.attachmentId, props.mimeType]) : false));
  const [asset, { refetch }] = createResource(assetKey, async () => {
    if (remote()) return remote();
    const result = await mainBridge.call(MAIN_CHANNELS.CHAT_REQUEST, {
      operation: "asset",
      threadId: props.threadId,
      path: local(),
      ...(props.attachmentId ? { attachmentId: props.attachmentId } : {}),
      ...(props.mimeType ? { mimeType: props.mimeType } : {}),
    });
    setFilePath(result.filePath);
    return result.url;
  });
  const image = () => props.image || /\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(props.path);
  const video = () => /\.(mp4|webm|mov)(?:[?#]|$)/i.test(props.path);
  const audio = () => /\.(mp3|m4a|wav|ogg)(?:[?#]|$)/i.test(props.path);
  const label = () => props.label || props.path;
  const link = "text-primary underline underline-offset-2";
  const open = (event: MouseEvent) => {
    event.preventDefault();
    const url = asset();
    if (url) void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url });
  };
  return (
    <span class="contents">
      <Show when={!asset.error} fallback={<button type="button" class={link} onClick={() => void refetch()}>Retry {label()}</button>}>
        <Show when={filePath()}>
          <button
            type="button"
            class={link}
            title="Show file in Finder"
            onClick={() => void mainBridge.call(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, { path: filePath()! })}
          >
            {label()} ↗
          </button>
        </Show>
        <Show when={!filePath()}>
          <Show when={asset()} fallback={<span class="text-muted-foreground">{label()}{asset.loading ? " …" : ""}</span>}>
            {(url) =>
              image() ? (
                <img
                  src={url()}
                  alt={label()}
                  loading="lazy"
                  class="my-1 max-h-60 max-w-full rounded-md border border-border object-contain"
                  onError={() => {
                    if (retried) return;
                    retried = true;
                    void refetch();
                  }}
                />
              ) : video() ? (
                <video controls preload="metadata" src={url()} class="my-1 max-h-60 max-w-full rounded-md" />
              ) : audio() ? (
                <audio controls preload="metadata" src={url()} class="my-1 w-full" />
              ) : (
                <a href={url()} class={link} onClick={open}>{label()}</a>
              )
            }
          </Show>
        </Show>
      </Show>
    </span>
  );
}

/** The classes that give the rendered Markdown its 12 px, muted-chrome look. */
const MARKDOWN_CLASS = [
  "text-[12px] leading-5 text-foreground break-words min-w-0 max-w-full",
  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_strong]:font-450 [&_b]:font-450",
  "[&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul]:pl-4 [&_ol]:pl-4 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-input [&_code]:px-1 [&_code]:py-px [&_code]:text-[11px] [&_code]:font-mono",
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-input [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-2 [&_hr]:border-border",
  "[&_table]:my-1.5 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border [&_th]:px-1.5 [&_td]:px-1.5 [&_th]:py-0.5 [&_td]:py-0.5 [&_th]:text-left",
].join(" ");

export function Markdown(props: { text: string; threadId: string }) {
  const tokens = createMemo(() => marked.lexer(props.text));
  const inline = (tokens: Token[] | undefined, text = ""): JSX.Element => (tokens ? <For each={tokens}>{(token) => render(token)}</For> : text);
  const render = (token: Token): JSX.Element => {
    switch (token.type) {
      case "space":
        return null;
      case "heading":
        return <div class="mt-3 mb-1 text-[13px] font-450 first:mt-0">{inline((token as Tokens.Heading).tokens)}</div>;
      case "paragraph":
        return <p>{inline((token as Tokens.Paragraph).tokens)}</p>;
      case "text": {
        const value = token as Tokens.Text;
        return inline(value.tokens, value.text);
      }
      case "strong":
        return <strong>{inline((token as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em>{inline((token as Tokens.Em).tokens)}</em>;
      case "del":
        return <del>{inline((token as Tokens.Del).tokens)}</del>;
      case "codespan":
        return <code>{(token as Tokens.Codespan).text}</code>;
      case "code":
        return (
          <div class="group relative my-1.5">
            <button
              type="button"
              aria-label="Copy code"
              class="absolute right-1 top-1 hidden rounded bg-muted px-1 py-px text-[10px] text-muted-foreground hover:text-foreground group-hover:block focus-ring"
              onClick={() => void navigator.clipboard.writeText((token as Tokens.Code).text)}
            >
              Copy
            </button>
            <pre><code>{(token as Tokens.Code).text}</code></pre>
          </div>
        );
      case "br":
        return <br />;
      case "hr":
        return <hr />;
      case "blockquote":
        return <blockquote>{inline((token as Tokens.Blockquote).tokens)}</blockquote>;
      case "list": {
        const list = token as Tokens.List;
        const items = (
          <For each={list.items}>
            {(item) => (
              <li>
                <Show when={item.task}>
                  <input type="checkbox" checked={item.checked} disabled class="mr-1 align-middle" />
                </Show>
                {inline(item.tokens)}
              </li>
            )}
          </For>
        );
        return list.ordered ? <ol start={list.start || 1}>{items}</ol> : <ul>{items}</ul>;
      }
      case "table": {
        const table = token as Tokens.Table;
        return (
          <div class="overflow-x-auto">
            <table>
              <thead><tr><For each={table.header}>{(cell) => <th>{inline(cell.tokens)}</th>}</For></tr></thead>
              <tbody><For each={table.rows}>{(row) => <tr><For each={row}>{(cell) => <td>{inline(cell.tokens)}</td>}</For></tr>}</For></tbody>
            </table>
          </div>
        );
      }
      case "link": {
        const value = token as Tokens.Link;
        return <ChatAsset threadId={props.threadId} path={value.href} label={value.text} />;
      }
      case "image": {
        const value = token as Tokens.Image;
        return <ChatAsset threadId={props.threadId} path={value.href} label={value.text} image />;
      }
      case "escape":
        return (token as Tokens.Escape).text;
      // Raw HTML and unknown extensions stay inert text.
      default:
        return "text" in token ? String(token.text) : token.raw;
    }
  };
  return <div class={MARKDOWN_CLASS}><For each={tokens()}>{render}</For></div>;
}
