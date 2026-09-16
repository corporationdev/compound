/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show } from "solid-js";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { assetTransfer, cloudAssets, retryAssetTransfer } from "@/engine/cloud-assets";
import { cx } from "@/lib/cva";
import { formatBytes } from "@/utils/formatters";

import type { AssetTransfer } from "@/engine/cloud-assets";

/** What a transfer is doing, for a list row and a badge title. */
export function describeTransfer(transfer: AssetTransfer): string {
  const what = transfer.variant === "proxy" ? "proxy" : "original";
  if (transfer.phase === "waiting") return `Waiting for another machine to finish uploading the ${what}`;
  if (transfer.phase === "failed") return `${transfer.kind === "upload" ? "Upload" : "Download"} of the ${what} failed: ${transfer.error ?? "unknown error"}`;
  if (transfer.phase === "queued") return `${transfer.kind === "upload" ? "Upload" : "Download"} of the ${what} queued`;
  return `${transfer.kind === "upload" ? "Uploading" : "Downloading"} the ${what}: ${percent(transfer)}%`;
}

export function percent(transfer: AssetTransfer): number {
  return transfer.total > 0 ? Math.min(100, Math.floor((transfer.bytes / transfer.total) * 100)) : 0;
}

/** A short label for an asset's badge: an arrow and a percentage, or a word. */
export function badgeLabel(sampleId: string): { text: string; title: string; tone: "moving" | "waiting" | "failed" } | null {
  const transfer = assetTransfer(sampleId);
  if (!transfer) return null;
  const title = describeTransfer(transfer);
  if (transfer.phase === "failed") return { text: "!", title, tone: "failed" };
  if (transfer.phase === "waiting") return { text: "…", title, tone: "waiting" };
  const arrow = transfer.kind === "upload" ? "↑" : "↓";
  return { text: transfer.phase === "active" ? `${arrow} ${percent(transfer)}%` : arrow, title, tone: "moving" };
}

/**
 * What the open project's media is doing between this machine and the
 * cloud: counts of uploads and downloads under way as a pill, the list of
 * them behind it. Nothing when nothing is moving.
 */
export function CloudAssetsPill() {
  const summary = () => cloudAssets()?.summary;
  const moving = () => {
    const current = summary();
    return !!current && current.uploading + current.downloading + current.waiting + current.failed > 0;
  };
  const transfers = () => cloudAssets()?.transfers.filter((transfer) => transfer.phase !== "done") ?? [];
  const label = () => {
    const current = summary()!;
    const parts: string[] = [];
    if (current.uploading) parts.push(`↑ ${current.uploading}`);
    if (current.downloading) parts.push(`↓ ${current.downloading}`);
    if (current.waiting) parts.push(`… ${current.waiting}`);
    if (current.failed) parts.push(`! ${current.failed}`);
    return parts.join(" ");
  };
  const title = () => {
    const current = summary()!;
    const lines: string[] = [];
    if (current.uploading) lines.push(`${current.uploading} upload${current.uploading === 1 ? "" : "s"}`);
    if (current.downloading) lines.push(`${current.downloading} download${current.downloading === 1 ? "" : "s"}`);
    if (current.waiting) lines.push(`${current.waiting} waiting on another machine`);
    if (current.failed) lines.push(`${current.failed} failed`);
    if (current.bytesLeft) lines.push(`${formatBytes(current.bytesLeft)} left`);
    return lines.join("\n");
  };

  return (
    <Show when={moving()}>
      <Popover placement="bottom-end">
        <PopoverTrigger
          as="button"
          type="button"
          title={title()}
          class={cx(
            "flex shrink-0 items-center gap-1.5 rounded-full px-1.5 text-xxs text-muted-foreground hover:text-foreground",
            summary()?.failed ? "text-destructive" : "",
          )}
        >
          <span class={cx("size-1.5 rounded-full", summary()?.failed ? "bg-destructive" : "bg-muted-foreground animate-pulse")} />
          {label()}
        </PopoverTrigger>
        <PopoverContent class="w-72 p-2 text-xs">
          <p class="px-1 pb-1 text-muted-foreground">Media transfers</p>
          <ul class="flex max-h-64 flex-col gap-1 overflow-y-auto">
            <For each={transfers()}>
              {(transfer) => (
                <li class="flex flex-col gap-1 rounded px-1 py-1" title={describeTransfer(transfer)}>
                  <div class="flex items-center gap-2">
                    <span class="shrink-0 text-muted-foreground">{transfer.kind === "upload" ? "↑" : "↓"}</span>
                    <span class="truncate">{transfer.name}</span>
                    <span class="ml-auto shrink-0 text-muted-foreground">
                      {transfer.variant === "proxy" ? "proxy" : ""}
                    </span>
                    <Show when={transfer.phase === "failed"}>
                      <button type="button" class="shrink-0 text-destructive hover:underline" onClick={() => retryAssetTransfer(transfer.sampleId)}>
                        Retry
                      </button>
                    </Show>
                  </div>
                  <Show when={transfer.phase === "active" || transfer.phase === "queued"} fallback={
                    <span class={cx("truncate", transfer.phase === "failed" ? "text-destructive" : "text-muted-foreground")}>
                      {transfer.phase === "failed" ? transfer.error ?? "Failed" : "Waiting for another machine"}
                    </span>
                  }>
                    <div class="relative h-1 w-full overflow-hidden rounded-full bg-foreground/15">
                      <div class="h-full rounded-full bg-foreground transition-all" style={{ width: `${percent(transfer)}%` }} />
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </PopoverContent>
      </Popover>
    </Show>
  );
}
