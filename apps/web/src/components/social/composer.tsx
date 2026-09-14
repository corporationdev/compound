/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxControl, CheckboxInput, CheckboxLabel } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogPortal } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { TextField, TextFieldInput, TextFieldLabel, TextFieldTextArea } from "@/components/ui/text-field";
import { ConnectAccountMenu } from "@/components/social/connect-account-menu";
import { CoverPickerDialog, PostMediaCard, VideoPreviewDialog, timestamp, type SocialCover } from "@/components/social/media";
import { SchedulePicker, snapToScheduleGrid } from "@/components/social/schedule-picker";
import { useSocial, type PostJob } from "@/context/social";
import { createQuery } from "@/lib/convex";
import {
  MAX_CAPTION_LENGTH,
  MAX_TITLE_LENGTH,
  SOCIAL_PLATFORM_LABELS,
  STATUS_LABELS,
  cancelPost,
  formatPostTime,
  pickVideoFile,
  postMediaUrl,
  removePost,
  retryTarget,
  savePost,
  socialAccountsQuery,
  socialPlatformIcon,
  socialPostQuery,
  statusTone,
  submitPost,
  systemTimezone,
  type SocialAccount,
  type SocialPost,
  type SocialTarget,
} from "@/lib/social";
import { cx } from "@/lib/cva";
import { ElectronFileHandle } from "@/lib/electron-file-handle";
import { uploadToCloud } from "@/lib/upload";
import { formatBytes } from "@/utils/formatters";

import type { Id } from "@compound/backend/convex/_generated/dataModel";

const TONE_CLASS = {
  neutral: "bg-secondary text-muted-foreground",
  active: "bg-tertiary text-tertiary-foreground",
  success: "bg-success-accent text-success-accent-foreground",
  danger: "bg-destructive-accent text-destructive-accent-foreground",
} as const;

export function StatusPill(props: { status: SocialPost["status"]; class?: string }) {
  return (
    <span class={cx("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xxs font-450", TONE_CLASS[statusTone(props.status)], props.class)}>
      {STATUS_LABELS[props.status]}
    </span>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error && typeof (error as { data: unknown }).data === "string")
    return (error as { data: string }).data;
  return error instanceof Error ? error.message : "Something went wrong";
}

/** Editing state the composer owns until it is saved: the draft's fields plus the version they came from. */
type Draft = {
  version: number;
  caption: string;
  title: string;
  accountIds: Id<"socialAccounts">[];
  mode: "now" | "schedule";
  scheduledFor: number | null;
  timezone: string;
  cover: SocialCover;
};
function draftFrom(post: SocialPost): Draft {
  return {
    version: post.version,
    caption: post.caption,
    title: post.title ?? "",
    accountIds: post.accountIds,
    mode: post.scheduledFor === null ? "now" : "schedule",
    scheduledFor: post.scheduledFor,
    timezone: post.timezone || systemTimezone(),
    cover: post.cover,
  };
}

/** The render or upload running for this post, in place of the video until it exists. */
function JobProgress(props: { job: PostJob; onCancel: () => void }) {
  const percent = () => props.job.percent ?? 0;
  const label = () => (props.job.stage === "rendering" ? "Rendering" : "Uploading");
  const remaining = () => {
    const r = props.job.remaining;
    if (props.job.stage !== "rendering" || !r || (r.minutes === 0 && r.seconds === 0)) return null;
    return r.minutes > 0 ? `${r.minutes} min ${r.seconds} s left` : `${r.seconds} s left`;
  };
  return (
    <div class="flex w-56 flex-col items-center gap-2 text-muted-foreground text-xs">
      <div class="flex items-center gap-2">
        <Icon name="spinner-loader" class="size-4 animate-spin" />
        <span class="text-foreground">
          {label()} {percent()}%
        </span>
      </div>
      <div class="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div class="h-full bg-primary transition-[width]" style={{ width: `${percent()}%` }} />
      </div>
      <div class="flex h-4 items-center">
        <Show when={remaining()}>{(text) => <span class="text-xxs">{text()}</span>}</Show>
      </div>
      <Button size="small" variant="secondary" onClick={props.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Size of an image file, for the cover upload's metadata. */
function imageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not open the image"));
    };
    image.src = url;
  });
}

/**
 * The left column: the render or upload while it runs, then the cover card
 * with Preview and Edit cover. The video plays from the rendered file on
 * disk when this machine has it, so the preview does not wait for the upload.
 */
function MediaPane(props: {
  post: SocialPost;
  job: PostJob | undefined;
  cover: SocialCover;
  editable: boolean;
  onCancel: () => void;
  onCover: (cover: SocialCover) => void;
}) {
  const [remote] = createResource(
    () => (props.post.media?.ready ? props.post.media.id : null),
    (id) => postMediaUrl(id),
  );
  // The local file, when the video was rendered or picked here.
  const [local] = createResource(
    () => (window.desktop ? props.job?.path : undefined),
    async (path) => URL.createObjectURL(await new ElectronFileHandle(path).getFile()),
  );
  onCleanup(() => {
    const url = local.latest;
    if (url) URL.revokeObjectURL(url);
  });
  const src = () => local() ?? remote() ?? null;
  const coverMediaId = () => (props.cover && "mediaId" in props.cover ? props.cover.mediaId : null);
  const [remoteCover] = createResource(
    () => (props.post.coverReady ? coverMediaId() : null),
    (id) => postMediaUrl(id),
  );
  const [localCover, setLocalCover] = createSignal<string | null>(null);
  const coverImageUrl = () => (coverMediaId() ? (localCover() ?? remoteCover() ?? null) : null);

  const [previewing, setPreviewing] = createSignal(false);
  const [editingCover, setEditingCover] = createSignal(false);
  const [uploadingCover, setUploadingCover] = createSignal(false);
  const chooseImage = async (file: File) => {
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      toast.error("Choose a JPEG or PNG image");
      return;
    }
    setUploadingCover(true);
    try {
      const size = await imageSize(file);
      const mediaId = await uploadToCloud({ purpose: "social", kind: "cover", contentType: file.type, ...size }, { blob: file });
      const previous = localCover();
      if (previous) URL.revokeObjectURL(previous);
      setLocalCover(URL.createObjectURL(file));
      props.onCover({ mediaId: mediaId as Id<"socialMedia"> });
    } catch (error) {
      toast.error("Could not use that image", { description: errorMessage(error) });
    } finally {
      setUploadingCover(false);
    }
  };

  const working = () => props.job?.stage === "rendering" || props.job?.stage === "uploading";
  const shape = () => ({
    width: props.post.media?.width ?? null,
    height: props.post.media?.height ?? null,
    durationMs: props.post.media?.durationMs ?? null,
  });
  const durationSeconds = () => (props.post.media?.durationMs ?? 0) / 1000;
  const details = () => {
    const media = props.post.media;
    if (!media) return null;
    return [
      media.durationMs ? timestamp(media.durationMs / 1000) : null,
      media.width && media.height ? `${media.width}×${media.height}` : null,
      formatBytes(media.size),
    ]
      .filter(Boolean)
      .join(" · ");
  };

  return (
    <div class="flex flex-col items-center gap-2">
      <Show
        when={src()}
        fallback={
          <div class="flex h-[420px] w-full flex-col items-center justify-center gap-2 rounded-2xl bg-overlay-soft text-muted-foreground text-xs">
            <Show when={working() && props.job}>{(job) => <JobProgress job={job()} onCancel={props.onCancel} />}</Show>
            <Show when={props.job?.stage === "error"}>
              <Icon name="alert-warning" class="size-5" />
              <span class="max-w-64 text-center">{props.job?.error}</span>
            </Show>
            <Show when={!props.job && !props.post.media}>
              <span>No video yet</span>
            </Show>
            <Show when={!props.job && props.post.media && !props.post.media.ready}>
              <Icon name="spinner-loader" class="size-5 animate-spin" />
              <span>Waiting for upload…</span>
            </Show>
            <Show when={!working() && props.job?.stage !== "error" && (remote.loading || local.loading)}>
              <Icon name="spinner-loader" class="size-5 animate-spin" />
            </Show>
          </div>
        }
      >
        <PostMediaCard
          src={src()}
          cover={props.cover}
          coverImageUrl={coverImageUrl()}
          shape={shape()}
          editable={props.editable}
          onPreview={() => setPreviewing(true)}
          onEditCover={() => setEditingCover(true)}
        />
      </Show>
      <Show when={src() && working() ? props.job : undefined}>{(job) => <JobProgress job={job()} onCancel={props.onCancel} />}</Show>
      <Show when={details()}>{(text) => <p class="text-muted-foreground text-xxs">{text()}</p>}</Show>
      <VideoPreviewDialog src={src()} open={previewing()} onClose={() => setPreviewing(false)} />
      <CoverPickerDialog
        open={editingCover()}
        src={src()}
        durationSeconds={durationSeconds()}
        cover={props.cover}
        coverImageUrl={coverImageUrl()}
        uploadingImage={uploadingCover()}
        onChoose={props.onCover}
        onImage={(file) => void chooseImage(file)}
        onClose={() => setEditingCover(false)}
      />
    </div>
  );
}

function TargetRow(props: { target: SocialTarget; onRetry: () => void }) {
  return (
    <div class="flex items-start gap-2 py-1.5">
      <Icon name={socialPlatformIcon(props.target.platform)} class="mt-0.5 size-4 shrink-0 text-foreground" />
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex items-center gap-2">
          <span class="truncate text-xs">@{props.target.username}</span>
          <StatusPill status={props.target.status} />
        </div>
        <Show when={props.target.error}>
          <p class="text-destructive text-xxs">{props.target.error}</p>
        </Show>
        <Show when={props.target.status === "scheduled" && props.target.scheduledFor}>
          <p class="text-muted-foreground text-xxs">Goes out {formatPostTime(props.target.scheduledFor!, props.target.timezone)}</p>
        </Show>
      </div>
      <Show when={props.target.postUrl}>
        <Button size="small" variant="ghost" as="a" href={props.target.postUrl!} target="_blank" rel="noreferrer">
          Open
        </Button>
      </Show>
      <Show when={props.target.status === "failed" || props.target.status === "checking"}>
        <Button size="small" variant="secondary" onClick={props.onRetry}>
          Retry
        </Button>
      </Show>
    </div>
  );
}

/**
 * One composer for every entry point. It edits the draft with a debounced
 * autosave and shows delivery state once submitted. Post/Schedule stays
 * disabled until the backend has the video.
 */
export function PostComposer() {
  const social = useSocial();
  const postId = social.composerPostId;
  const post = createQuery(socialPostQuery, () => (postId() ? { postId: postId()! } : null));
  const accounts = createQuery(socialAccountsQuery, () => (postId() ? {} : null));
  const job = () => (postId() ? social.jobs()[postId()!] : undefined);

  const [draft, setDraft] = createSignal<Draft | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);

  // Adopt the server's copy when the composer opens or when the version moves
  // for a reason other than our own save (a submit, a cancel, dispatch).
  createEffect(
    on(
      () => post().data,
      (data) => {
        if (!data) {
          setDraft(null);
          return;
        }
        const current = draft();
        if (!current || (current.version !== data.version && !saving())) setDraft(draftFrom(data));
      },
    ),
  );

  const editable = () => {
    const status = post().data?.status;
    return status === "draft" || status === "scheduled" || status === "failed" || status === "partial";
  };
  const isScheduledLive = () => post().data?.status === "scheduled";

  // Debounced autosave of text and settings; the backend bumps the version.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    const current = draft();
    const id = postId();
    if (!current || !id || !dirty() || !editable()) return;
    setSaving(true);
    try {
      const version = await savePost(id, {
        expectedVersion: current.version,
        caption: current.caption,
        title: current.title.trim() ? current.title : null,
        accountIds: current.accountIds,
        scheduledFor: current.mode === "schedule" ? current.scheduledFor : null,
        timezone: current.timezone,
        cover: current.cover,
      });
      setDraft((d) => (d ? { ...d, version } : d));
      setDirty(false);
    } catch (error) {
      toast.error("Could not save the post", { description: errorMessage(error) });
      const data = post().data;
      if (data) setDraft(draftFrom(data));
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 600);
  };
  onCleanup(() => clearTimeout(timer));

  const selectedPlatforms = createMemo(() => {
    const ids = new Set(draft()?.accountIds ?? []);
    return new Set((accounts().data ?? []).filter((a: SocialAccount) => ids.has(a.id)).map((a: SocialAccount) => a.platform));
  });
  const wantsTitle = () => selectedPlatforms().has("youtube") || selectedPlatforms().has("facebook");
  const captionLength = () => [...(draft()?.caption ?? "")].length;

  const canSubmit = () => {
    const d = draft();
    const data = post().data;
    return (
      !!d &&
      !!data &&
      editable() &&
      !busy() &&
      data.media?.ready === true &&
      d.accountIds.length > 0 &&
      captionLength() <= MAX_CAPTION_LENGTH &&
      (d.mode === "now" || (d.scheduledFor !== null && d.scheduledFor > Date.now() + 60_000))
    );
  };

  const submit = async () => {
    const id = postId();
    if (!id) return;
    setBusy(true);
    try {
      clearTimeout(timer);
      await flush();
      const version = draft()?.version;
      if (version === undefined) return;
      await submitPost(id, version);
      toast(draft()?.mode === "schedule" ? "Post scheduled" : "Posting now", {
        description: "Follow its progress in Posts.",
      });
    } catch (error) {
      toast.error("Could not post", { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const id = postId();
    if (!id) return;
    setBusy(true);
    try {
      await cancelPost(id);
    } catch (error) {
      toast.error("Could not cancel", { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const id = postId();
    if (!id) return;
    setBusy(true);
    try {
      social.cancelJob(id);
      await removePost(id);
      social.closeComposer();
    } catch (error) {
      toast.error("Could not delete", { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const retry = async (target: SocialTarget) => {
    try {
      await retryTarget(target.id);
    } catch (error) {
      toast.error("Could not retry", { description: errorMessage(error) });
    }
  };
  const replaceVideo = async () => {
    const id = postId();
    if (!id) return;
    if (window.desktop) {
      const picked = await pickVideoFile();
      if (picked) void social.attachVideo(id, { path: picked.path });
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "video/mp4";
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void social.attachVideo(id, { file });
      };
      input.click();
    }
  };

  const close = async () => {
    clearTimeout(timer);
    // Save first: the context deletes drafts that are still empty on close.
    await flush();
    social.closeComposer();
  };

  const title = () => {
    const data = post().data;
    if (!data) return "Post";
    if (data.projectName) return `Post · ${data.projectName}`;
    return "Post";
  };

  return (
    <Dialog open={postId() !== null} preventScroll={false} onOpenChange={(open) => !open && void close()}>
      <DialogPortal>
        <DialogContent showCloseButton={false} class="w-[52rem] max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-hidden rounded-xl border-border p-0 gap-0">
          <div class="flex max-h-[calc(100vh-2rem)] flex-col">
            <div class="flex items-center gap-2 border-b border-border py-2 pl-4 pr-2">
              <p class="min-w-0 flex-1 truncate text-xs text-foreground">{title()}</p>
              <Show when={post().data && post().data!.status !== "draft"}>
                <StatusPill status={post().data!.status} />
              </Show>
              <Button size="icon" variant="ghost" class="text-muted-foreground" onClick={() => void close()}>
                <Icon name="close-remove" class="text-foreground" />
              </Button>
            </div>

            <Show
              when={post().data && draft()}
              fallback={
                <div class="flex h-64 items-center justify-center text-muted-foreground text-xs">
                  <Show when={post().status === "error"} fallback={<Icon name="spinner-loader" class="size-5 animate-spin" />}>
                    {post().error?.message}
                  </Show>
                </div>
              }
            >
              <div class="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div class="flex flex-col gap-3">
                  <MediaPane
                    post={post().data!}
                    job={job()}
                    cover={draft()!.cover}
                    editable={editable() && !isScheduledLive()}
                    onCancel={() => social.cancelJob(postId()!)}
                    onCover={(cover) => update({ cover })}
                  />
                  <Show when={editable() && !isScheduledLive() && job()?.stage !== "rendering" && job()?.stage !== "uploading"}>
                    <Button variant="secondary" class="w-fit" onClick={() => void replaceVideo()}>
                      {post().data!.media ? "Replace video…" : "Choose video…"}
                    </Button>
                  </Show>
                  <Show when={post().data!.targets.length > 0}>
                    <div class="flex flex-col divide-y divide-border rounded-md border border-border px-2">
                      <For each={post().data!.targets}>{(target) => <TargetRow target={target} onRetry={() => void retry(target)} />}</For>
                    </div>
                  </Show>
                </div>

                <div class="flex flex-col gap-4">
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <p class="text-xs text-foreground">Accounts</p>
                      <Show when={editable() && !isScheduledLive()}>
                        <ConnectAccountMenu variant="ghost" size="small" class="text-muted-foreground" onBeforeConnect={flush}>
                          <Icon name="plus-add-small" class="size-3.5 mr-0.5" />
                          Connect account
                        </ConnectAccountMenu>
                      </Show>
                    </div>
                    <Show
                      when={(accounts().data ?? []).length > 0}
                      fallback={
                        <p class="text-muted-foreground text-xs">No accounts connected. Connect one to post.</p>
                      }
                    >
                      <div class="flex flex-col gap-1">
                        <For each={accounts().data as SocialAccount[]}>
                          {(account) => {
                            const checked = () => draft()!.accountIds.includes(account.id);
                            return (
                              <Checkbox
                                checked={checked()}
                                disabled={!editable() || isScheduledLive()}
                                onChange={(value: boolean) =>
                                  update({
                                    accountIds: value
                                      ? [...draft()!.accountIds, account.id]
                                      : draft()!.accountIds.filter((id) => id !== account.id),
                                  })
                                }
                                class="flex items-center gap-2"
                              >
                                <CheckboxInput />
                                <CheckboxControl />
                                <CheckboxLabel class="flex items-center gap-2 text-xs">
                                  <Icon name={socialPlatformIcon(account.platform)} class="size-4" />
                                  <span>@{account.username}</span>
                                  <span class="text-muted-foreground">{SOCIAL_PLATFORM_LABELS[account.platform]}</span>
                                </CheckboxLabel>
                              </Checkbox>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>

                  <Show when={wantsTitle()}>
                    <TextField class="flex flex-col gap-1.5">
                      <TextFieldLabel class="text-xs">Title</TextFieldLabel>
                      <TextFieldInput
                        value={draft()!.title}
                        disabled={!editable()}
                        placeholder="Used by YouTube and Facebook Reels"
                        maxLength={MAX_TITLE_LENGTH}
                        onInput={(e) => update({ title: e.currentTarget.value })}
                      />
                    </TextField>
                  </Show>

                  <TextField class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between">
                      <TextFieldLabel class="text-xs">Caption</TextFieldLabel>
                      <span class={cx("text-xxs", captionLength() > MAX_CAPTION_LENGTH ? "text-destructive" : "text-muted-foreground")}>
                        {captionLength()}/{MAX_CAPTION_LENGTH}
                      </span>
                    </div>
                    <TextFieldTextArea
                      value={draft()!.caption}
                      disabled={!editable()}
                      rows={6}
                      placeholder="Write a caption…"
                      onInput={(e) => update({ caption: e.currentTarget.value })}
                    />
                  </TextField>

                  <div class="flex flex-col gap-1.5">
                    <p class="text-xs text-foreground">When</p>
                    <div class="flex gap-1 rounded-md bg-secondary p-0.5 w-fit">
                      <Button
                        size="small"
                        variant={draft()!.mode === "now" ? "on" : "ghost"}
                        disabled={!editable() || isScheduledLive()}
                        onClick={() => update({ mode: "now" })}
                      >
                        Now
                      </Button>
                      <Button
                        size="small"
                        variant={draft()!.mode === "schedule" ? "on" : "ghost"}
                        disabled={!editable()}
                        onClick={() =>
                          update({
                            mode: "schedule",
                            scheduledFor: draft()!.scheduledFor ?? snapToScheduleGrid(Date.now() + 60 * 60_000),
                          })
                        }
                      >
                        Schedule
                      </Button>
                    </div>
                    <Show when={draft()!.mode === "schedule"}>
                      <SchedulePicker
                        value={draft()!.scheduledFor}
                        timezone={draft()!.timezone}
                        disabled={!editable()}
                        onChange={(scheduledFor) => update({ scheduledFor })}
                      />
                      <Show when={draft()!.scheduledFor !== null && draft()!.scheduledFor! <= Date.now() + 60_000}>
                        <p class="text-destructive text-xxs">Choose a time at least a minute from now.</p>
                      </Show>
                    </Show>
                  </div>
                </div>
              </div>

              <div class="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
                <div class="flex items-center gap-2 text-muted-foreground text-xxs">
                  <Show when={post().data!.hasChanges && isScheduledLive()}>Changes not yet applied to the schedule</Show>
                </div>
                <div class="flex items-center gap-2">
                  <Show when={post().data!.status === "draft" || post().data!.status === "cancelled" || post().data!.status === "failed" || post().data!.status === "published"}>
                    <Button variant="ghost" disabled={busy()} onClick={() => void remove()}>
                      Delete
                    </Button>
                  </Show>
                  <Show when={["scheduled", "partial", "failed", "checking", "submitting", "queued", "uploading"].includes(post().data!.status)}>
                    <Button variant="secondary" disabled={busy()} onClick={() => void cancel()}>
                      Cancel schedule
                    </Button>
                  </Show>
                  <Show when={editable()}>
                    <Button disabled={!canSubmit()} onClick={() => void submit()}>
                      {isScheduledLive() ? "Save changes" : draft()!.mode === "schedule" ? "Schedule" : "Post now"}
                    </Button>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
