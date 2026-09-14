/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The composer's media surface, ported from PostBob: the card shows the
// chosen cover still, playback is an explicit Preview action with our own
// controls, and the cover is picked on a filmstrip or replaced with an image.

import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogPortal } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Slider, SliderFill, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { cx } from "@/lib/cva";

import type { SocialPost } from "@/lib/social";

export type SocialCover = SocialPost["cover"];
export type MediaShape = { width: number | null; height: number | null; durationMs: number | null };

const FILMSTRIP_FRAMES = 7;

export const timestamp = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const coverSeconds = (cover: SocialCover) => (cover && "offsetMs" in cover ? cover.offsetMs / 1000 : 0);

/** Card size from the video's own aspect ratio: portrait posts stand tall, landscape ones lie wide. */
function cardSize(shape: MediaShape) {
  const ratio = shape.width && shape.height ? shape.width / shape.height : 9 / 16;
  if (ratio < 1) return { width: Math.round(420 * ratio), height: 420 };
  return { width: 400, height: Math.round(400 / ratio) };
}

async function seekTo(video: HTMLVideoElement, seconds: number) {
  if (video.readyState < 1) await new Promise<void>((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
  if (Math.abs(video.currentTime - seconds) < 0.01) return;
  await new Promise<void>((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = seconds;
  });
}

/**
 * Small stills across the video for the filmstrip. Drawing needs a
 * same-origin source; a signed bucket URL taints the canvas, in which case
 * the strip falls back to a plain track and the big preview still works.
 */
export async function captureFrames(src: string, durationSeconds: number, count = FILMSTRIP_FRAMES): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = src;
  const canvas = document.createElement("canvas");
  const frames: string[] = [];
  try {
    await seekTo(video, 0);
    const scale = Math.min(1, 160 / Math.max(video.videoWidth, video.videoHeight, 1));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return [];
    for (let i = 0; i < count; i++) {
      await seekTo(video, (i / count) * Math.max(0.01, durationSeconds - 0.05));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.7));
    }
    return frames;
  } catch {
    return [];
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** A paused video showing the frame at `seconds`; the cheapest way to render a still from any source. */
export function FrameStill(props: { src: string; seconds: number; class?: string; onReady?: () => void }) {
  let video: HTMLVideoElement | undefined;
  createEffect(
    on(
      () => [props.src, props.seconds] as const,
      () => {
        if (video) void seekTo(video, props.seconds).then(() => props.onReady?.());
      },
    ),
  );
  return <video ref={video} src={props.src} muted playsinline preload="auto" class={cx("pointer-events-none", props.class)} />;
}

/**
 * The chosen still in the video's shape, with Preview above and Edit cover
 * below. Playback never happens in the card itself.
 */
export function PostMediaCard(props: {
  src: string | null;
  cover: SocialCover;
  /** A ready custom cover image, when the cover is one. */
  coverImageUrl: string | null;
  shape: MediaShape;
  editable: boolean;
  onPreview: () => void;
  onEditCover: () => void;
}) {
  const size = createMemo(() => cardSize(props.shape));
  return (
    <div
      class="relative shrink-0 overflow-hidden rounded-2xl bg-overlay-soft text-white"
      style={{ width: `${size().width}px`, height: `${size().height}px` }}
    >
      <Show when={props.coverImageUrl} fallback={<Show when={props.src}>{(src) => <FrameStill src={src()} seconds={coverSeconds(props.cover)} class="size-full object-cover" />}</Show>}>
        {(url) => <img src={url()} alt="" class="size-full object-cover" />}
      </Show>
      <Show when={props.src}>
        <button
          type="button"
          onClick={props.onPreview}
          class="absolute top-1.5 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1 rounded-lg bg-black/55 px-2.5 text-xs font-450 backdrop-blur-sm hover:bg-black/70"
        >
          <Icon name="play" class="size-3.5" />
          Preview
        </button>
        <Show when={props.editable}>
          <button
            type="button"
            onClick={props.onEditCover}
            class="absolute bottom-1.5 left-1/2 flex h-7 -translate-x-1/2 items-center rounded-lg bg-black/55 px-2.5 text-xs font-450 backdrop-blur-sm hover:bg-black/70"
          >
            Edit cover
          </button>
        </Show>
      </Show>
    </div>
  );
}

/** Our own player: click to play or pause, a scrubber, time, mute. No native chrome. */
export function VideoPreviewDialog(props: { src: string | null; open: boolean; onClose: () => void }) {
  let video: HTMLVideoElement | undefined;
  const [duration, setDuration] = createSignal(0);
  const [seconds, setSeconds] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [muted, setMuted] = createSignal(false);
  const [waiting, setWaiting] = createSignal(true);
  const [scrubbing, setScrubbing] = createSignal(false);
  let resumeAfterScrub = false;

  const toggle = () => {
    if (!video || !duration()) return;
    if (video.paused) {
      if (seconds() >= duration() - 0.1) video.currentTime = 0;
      void video.play().catch(() => {});
    } else video.pause();
  };
  createEffect(() => {
    if (!props.open && video) video.pause();
  });

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPortal>
        <DialogContent showCloseButton={false} class="z-[10000] w-fit max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] gap-0 rounded-2xl border-border bg-black p-0 text-white">
          <div class="flex items-center px-2 py-1.5">
            <Button size="icon" variant="ghost" class="text-white hover:bg-white/10" onClick={props.onClose} aria-label="Close preview">
              <Icon name="close-remove" class="size-4" />
            </Button>
            <span class="flex-1 text-center text-xs font-450">Preview</span>
            <span class="w-6" />
          </div>
          <div class="relative flex max-h-[70vh] items-center justify-center px-3">
            <Show when={props.src}>
              {(src) => (
                <video
                  ref={video}
                  src={src()}
                  playsinline
                  preload="auto"
                  autoplay
                  class="max-h-[70vh] max-w-[80vw] cursor-pointer rounded-xl"
                  onClick={toggle}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                  onTimeUpdate={(e) => {
                    if (!scrubbing()) setSeconds(e.currentTarget.currentTime);
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onWaiting={() => setWaiting(true)}
                  onPlaying={() => setWaiting(false)}
                  onCanPlay={() => setWaiting(false)}
                  onEnded={() => setPlaying(false)}
                />
              )}
            </Show>
            <Show when={waiting() && props.src}>
              <Icon name="spinner-loader" class="pointer-events-none absolute size-6 animate-spin" />
            </Show>
            <Show when={!waiting() && !playing() && !scrubbing()}>
              <div class="pointer-events-none absolute flex size-16 items-center justify-center rounded-full bg-black/45">
                <Icon name="play" class="size-7" />
              </div>
            </Show>
          </div>
          <div class="flex flex-col gap-2 px-5 pt-3 pb-4">
            <Slider
              minValue={0}
              maxValue={Math.max(0.01, duration())}
              step={0.01}
              value={[seconds()]}
              disabled={!duration()}
              onChange={([value]) => {
                if (!scrubbing()) {
                  setScrubbing(true);
                  resumeAfterScrub = playing();
                  video?.pause();
                }
                setSeconds(value ?? 0);
                if (video) video.currentTime = value ?? 0;
              }}
              onChangeEnd={() => {
                setScrubbing(false);
                if (resumeAfterScrub) void video?.play().catch(() => {});
              }}
              aria-label="Playback position"
            >
              <SliderTrack class="bg-white/20">
                <SliderFill class="bg-white" />
                <SliderThumb class="border-black bg-white ring-white/30" />
              </SliderTrack>
            </Slider>
            <div class="flex items-center gap-3">
              <Button size="icon" variant="ghost" class="text-white hover:bg-white/10" onClick={toggle} aria-label={playing() ? "Pause" : "Play"}>
                <Icon name={playing() ? "pause" : "play"} class="size-4" />
              </Button>
              <span class="font-mono text-xs text-white/70">
                {timestamp(seconds())} / {timestamp(duration())}
              </span>
              <span class="flex-1" />
              <Button
                size="icon"
                variant="ghost"
                class="text-white hover:bg-white/10"
                aria-label={muted() ? "Unmute" : "Mute"}
                onClick={() => {
                  setMuted(!muted());
                  if (video) video.muted = muted();
                }}
              >
                <Icon name={muted() ? "audio-off" : "audio-on"} class="size-4" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}

/**
 * Choose a frame on the filmstrip or use an image instead. Frame choice
 * reports on every drag so the card behind updates live; the dialog just
 * closes with Done.
 */
export function CoverPickerDialog(props: {
  open: boolean;
  src: string | null;
  durationSeconds: number;
  cover: SocialCover;
  coverImageUrl: string | null;
  uploadingImage: boolean;
  onChoose: (cover: SocialCover) => void;
  onImage: (file: File) => void;
  onClose: () => void;
}) {
  const [frames] = createResource(
    () => (props.open && props.src ? { src: props.src, duration: props.durationSeconds } : null),
    ({ src, duration }) => captureFrames(src, duration),
  );
  const isImage = () => !!props.cover && "mediaId" in props.cover;
  const seconds = () => coverSeconds(props.cover);
  const travel = () => Math.max(0.01, props.durationSeconds - 0.05);
  const fraction = () => Math.min(1, Math.max(0, seconds() / travel()));

  let strip: HTMLDivElement | undefined;
  let dragging = false;
  const THUMB = 44;
  const select = (clientX: number) => {
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    const usable = Math.max(1, rect.width - THUMB);
    const f = Math.min(1, Math.max(0, (clientX - rect.left - THUMB / 2) / usable));
    props.onChoose({ offsetMs: Math.round(f * travel() * 1000) });
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    strip?.setPointerCapture(e.pointerId);
    select(e.clientX);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging) select(e.clientX);
  };
  const onPointerUp = () => {
    dragging = false;
  };
  onCleanup(() => (dragging = false));

  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) props.onImage(file);
    };
    input.click();
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPortal>
        <DialogContent showCloseButton={false} class="z-[10000] w-[30rem] max-w-[calc(100%-2rem)] gap-0 rounded-2xl border-border p-0">
          <div class="flex items-center border-b border-border py-2 pl-4 pr-2">
            <p class="flex-1 text-xs text-foreground">Edit cover</p>
            <Button size="small" onClick={props.onClose}>
              Done
            </Button>
          </div>
          <div class="flex flex-col gap-4 p-4">
            <p class="text-center text-xs text-muted-foreground">Choose a frame from your video or use an image.</p>
            <div class="flex h-80 items-center justify-center overflow-hidden rounded-2xl bg-overlay-soft">
              <Show when={props.uploadingImage} fallback={
                <Show when={isImage() && props.coverImageUrl} fallback={<Show when={props.src}>{(src) => <FrameStill src={src()} seconds={seconds()} class="max-h-full max-w-full" />}</Show>}>
                  {(url) => <img src={url()} alt="" class="max-h-full max-w-full" />}
                </Show>
              }>
                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                  <Icon name="spinner-loader" class="size-4 animate-spin" />
                  Preparing cover…
                </div>
              </Show>
            </div>
            <div
              ref={strip}
              role="slider"
              aria-label="Cover frame"
              aria-valuemin={0}
              aria-valuemax={Math.round(props.durationSeconds)}
              aria-valuenow={Math.round(seconds())}
              tabIndex={0}
              class="relative h-[70px] w-full touch-none select-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={(e) => {
                const delta = e.key === "ArrowRight" ? 0.01 : e.key === "ArrowLeft" ? -0.01 : 0;
                if (delta) props.onChoose({ offsetMs: Math.round(Math.min(1, Math.max(0, fraction() + delta)) * travel() * 1000) });
              }}
            >
              <div class="absolute inset-x-0 top-[5px] flex h-[60px] overflow-hidden rounded-md bg-secondary">
                <For each={frames() ?? []}>{(frame) => <img src={frame} alt="" class="h-full min-w-0 flex-1 object-cover opacity-60" draggable={false} />}</For>
              </div>
              <Show when={!isImage() && props.src}>
                <div
                  class="absolute top-0 h-[70px] overflow-hidden rounded-lg border-[3px] border-primary bg-secondary shadow-md"
                  style={{ width: `${THUMB}px`, left: `calc(${fraction()} * (100% - ${THUMB}px))` }}
                >
                  <FrameStill src={props.src!} seconds={seconds()} class="size-full object-cover" />
                </div>
              </Show>
            </div>
            <div class="flex items-center justify-center gap-2">
              <Button variant="secondary" disabled={props.uploadingImage} onClick={pickImage}>
                <Icon name="image-small" class="size-4 mr-1" />
                Use an image…
              </Button>
              <Show when={isImage()}>
                <Button variant="ghost" disabled={props.uploadingImage} onClick={() => props.onChoose({ offsetMs: 0 })}>
                  Use a video frame instead
                </Button>
              </Show>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
