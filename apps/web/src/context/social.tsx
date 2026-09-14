/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, createSignal, useContext, type Accessor, type JSX } from "solid-js";
import { toast } from "somoto";

import { PostComposer } from "@/components/social/composer";
import { cancelRender, type RenderProgress } from "@/context/render";
import {
  createPost,
  findMediaByHash,
  openDraft,
  probeVideo,
  readPost,
  removePostIfEmpty,
  savePost,
  uploadPostVideo,
  type CreatePostInput,
  type PostMediaMeta,
} from "@/lib/social";
import { assert } from "@/utils";

import type { Id } from "@compound/backend/convex/_generated/dataModel";

/**
 * Per-post work happening on this machine: the render and the upload. The
 * composer opens the moment a post is created and shows this state in place
 * of the video, so caption and accounts can be written while it runs; Post
 * is enabled once the backend marks the media ready.
 */
export type PostJob = {
  stage: "rendering" | "uploading" | "done" | "error";
  /** 0–100 for the current stage. */
  percent?: number;
  /** Encoder estimate, rendering only. */
  remaining?: { minutes: number; seconds: number };
  error?: string;
  /** The local file, when the video came from disk. */
  path?: string;
};
export type RenderedVideo = { path: string; durationMs?: number; width?: number; height?: number };
/** What the composer hands `renderScene`: report progress here, and know when the user cancelled. */
export type RenderHooks = { onProgress: (progress: RenderProgress) => void };
/** Post from the editor: the scene's identity, the hash of its render inputs, and how to produce the file. */
export type PostFromScene = {
  projectId: string;
  projectName: string;
  sceneId: string;
  /** Hash of everything the render depends on; equal hashes mean identical output. */
  contentHash: string;
  /** Produce the file. Returns a cached export instantly when the hash has not changed. */
  render: (hooks: RenderHooks) => Promise<RenderedVideo>;
};

type SocialContextValue = {
  composerPostId: Accessor<Id<"socialPosts"> | null>;
  openComposer: (postId: Id<"socialPosts">) => void;
  closeComposer: () => void;
  jobs: Accessor<Record<string, PostJob>>;
  /**
   * Open the scene's draft. When the draft already holds a video from the
   * same render inputs, nothing renders or uploads; otherwise the scene is
   * rendered (or its cached export reused) and attached.
   */
  startPostFromRender: (input: PostFromScene) => Promise<void>;
  /** Create a post from an MP4 already on disk (desktop). */
  startPostFromPath: (path: string, meta?: CreatePostInput) => Promise<void>;
  /** Create a post from a chosen File (browser). */
  startPostFromFile: (file: File, meta?: CreatePostInput) => Promise<void>;
  /** Attach a new video to an existing post (Replace video). */
  attachVideo: (postId: Id<"socialPosts">, source: { path: string } | { file: File }, meta?: PostMediaMeta) => Promise<void>;
  /** Stop the render or upload running for a post; the post stays a draft without a video. */
  cancelJob: (postId: Id<"socialPosts">) => void;
};

const SocialContext = createContext<SocialContextValue>();

export function SocialProvider(props: { children: JSX.Element }) {
  const [composerPostId, setComposerPostId] = createSignal<Id<"socialPosts"> | null>(null);
  const [jobs, setJobs] = createSignal<Record<string, PostJob>>({});
  const setJob = (postId: string, job: PostJob) => setJobs((all) => ({ ...all, [postId]: job }));
  const clearJob = (postId: string) =>
    setJobs((all) => {
      const rest = { ...all };
      delete rest[postId];
      return rest;
    });
  const uploads = new Map<string, AbortController>();

  const upload = async (postId: Id<"socialPosts">, source: { path: string } | { file: File }, meta: PostMediaMeta) => {
    const path = "path" in source ? { path: source.path } : {};
    setJob(postId, { stage: "uploading", percent: 0, ...path });
    let probed: Partial<PostMediaMeta> = {};
    if ("file" in source) {
      const url = URL.createObjectURL(source.file);
      try {
        probed = await probeVideo(url).catch(() => ({}));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const controller = new AbortController();
    uploads.set(postId, controller);
    try {
      const existing = meta.contentHash ? await findMediaByHash(meta.contentHash) : null;
      if (existing) {
        await savePost(postId, { mediaId: existing });
        setJob(postId, { stage: "done", ...path });
        return;
      }
      const mediaId = await uploadPostVideo(source, { ...probed, ...meta }, {
        signal: controller.signal,
        onProgress: (progress) =>
          setJob(postId, { stage: "uploading", percent: progress.total ? Math.round((progress.sent / progress.total) * 100) : 0, ...path }),
      });
      await savePost(postId, { mediaId });
      setJob(postId, { stage: "done", ...path });
    } finally {
      uploads.delete(postId);
    }
  };

  const fail = (postId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : "Something went wrong";
    setJob(postId, { stage: "error", error: message });
    toast.error("Could not prepare the post video", { description: message });
  };
  const cancelled = (error: unknown) => error instanceof Error && /cancel/i.test(error.message);

  const startPostFromRender: SocialContextValue["startPostFromRender"] = async ({ projectId, projectName, sceneId, contentHash, render }) => {
    const { postId, created } = await openDraft({ projectId, sceneId, projectName });
    setComposerPostId(postId);
    const current = created ? null : await readPost(postId).catch(() => null);
    const attached = current?.media;
    if (attached?.ready && attached.contentHash === contentHash) return;
    setJob(postId, { stage: "rendering", percent: 0 });
    try {
      const video = await render({
        onProgress: ({ percent, remaining }) => setJob(postId, { stage: "rendering", percent, remaining }),
      });
      await upload(postId, { path: video.path }, {
        projectId,
        projectName,
        sceneId,
        contentHash,
        durationMs: video.durationMs,
        width: video.width,
        height: video.height,
      });
      if (attached) toast("Video updated", { description: "The draft now uses the latest render of this scene." });
    } catch (error) {
      if (cancelled(error)) {
        clearJob(postId);
        void removePostIfEmpty(postId).catch(() => {});
      } else fail(postId, error);
    }
  };
  const startPostFromPath: SocialContextValue["startPostFromPath"] = async (path, meta = {}) => {
    const postId = await createPost(meta);
    setComposerPostId(postId);
    try {
      await upload(postId, { path }, meta);
    } catch (error) {
      if (cancelled(error)) clearJob(postId);
      else fail(postId, error);
    }
  };
  const startPostFromFile: SocialContextValue["startPostFromFile"] = async (file, meta = {}) => {
    const postId = await createPost(meta);
    setComposerPostId(postId);
    try {
      await upload(postId, { file }, meta);
    } catch (error) {
      if (cancelled(error)) clearJob(postId);
      else fail(postId, error);
    }
  };
  const attachVideo: SocialContextValue["attachVideo"] = async (postId, source, meta = {}) => {
    try {
      await upload(postId, source, meta);
    } catch (error) {
      if (cancelled(error)) clearJob(postId);
      else fail(postId, error);
    }
  };
  const cancelJob: SocialContextValue["cancelJob"] = (postId) => {
    const job = jobs()[postId];
    if (job?.stage === "rendering") cancelRender();
    else if (job?.stage === "uploading") uploads.get(postId)?.abort(new Error("Upload cancelled"));
  };

  return (
    <SocialContext.Provider
      value={{
        composerPostId,
        openComposer: (postId) => setComposerPostId(postId),
        closeComposer: () => {
          const postId = composerPostId();
          setComposerPostId(null);
          // A draft nothing went into is not worth keeping; a running render or upload is about to put a video in it.
          const job = postId ? jobs()[postId] : undefined;
          if (postId && job?.stage !== "rendering" && job?.stage !== "uploading") void removePostIfEmpty(postId).catch(() => {});
        },
        jobs,
        startPostFromRender,
        startPostFromPath,
        startPostFromFile,
        attachVideo,
        cancelJob,
      }}
    >
      {props.children}
      <PostComposer />
    </SocialContext.Provider>
  );
}

export function useSocial() {
  const ctx = useContext(SocialContext);
  assert(ctx, "useSocial must be used within SocialProvider");
  return ctx;
}
