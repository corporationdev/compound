/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useNavigate } from "@solidjs/router";
import { For, Show, createMemo, createResource, createSignal, onMount } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { StatusPill } from "@/components/social/composer";
import { FrameStill } from "@/components/social/media";
import { useSocial } from "@/context/social";
import { projectRoute } from "@/hooks/use-project-route";
import { createQuery } from "@/lib/convex";
import { cx } from "@/lib/cva";
import {
  formatPostTime,
  pickVideoFile,
  postMediaUrl,
  postSection,
  pruneEmptyDrafts,
  socialAccountsQuery,
  socialPlatformIcon,
  socialPostsQuery,
  type PostSection,
  type SocialPost,
} from "@/lib/social";
import { listProjects, projectKey, projectsRoot, type ProjectInfo } from "@/projects";

import { DashboardFormModal, DashboardSurfaceCard } from "./shared";

const SECTIONS: { key: PostSection; title: string; empty?: string }[] = [
  { key: "attention", title: "Needs attention" },
  { key: "upcoming", title: "Upcoming" },
  { key: "progress", title: "In progress" },
  { key: "drafts", title: "Drafts" },
  { key: "published", title: "Published" },
];

function whenLabel(post: SocialPost): string {
  const scheduled = post.targets.find((t) => t.status === "scheduled")?.scheduledFor ?? post.scheduledFor;
  if (post.status === "scheduled" && scheduled) return `Scheduled for ${formatPostTime(scheduled, post.timezone)}`;
  if (post.status === "published") {
    const at = Math.max(...post.targets.map((t) => t.updatedAt), post.updatedAt);
    return `Published ${formatPostTime(at, post.timezone)}`;
  }
  if (post.status === "draft" && scheduled) return `Draft for ${formatPostTime(scheduled, post.timezone)}`;
  return `Edited ${formatPostTime(post.updatedAt, post.timezone)}`;
}

/** The cover frame of the post's video, or a custom cover image, as the row's thumbnail. */
function PostThumbnail(props: { post: SocialPost }) {
  const [video] = createResource(
    () => (props.post.media?.ready ? props.post.media.id : null),
    (id) => postMediaUrl(id),
  );
  const [cover] = createResource(
    () => (props.post.coverReady && props.post.cover && "mediaId" in props.post.cover ? props.post.cover.mediaId : null),
    (id) => postMediaUrl(id),
  );
  const offset = () => (props.post.cover && "offsetMs" in props.post.cover ? props.post.cover.offsetMs / 1000 : 0);
  return (
    <div class="grid size-14 shrink-0 place-items-center overflow-hidden rounded-md bg-overlay-soft text-muted-foreground">
      <Show
        when={cover() ?? null}
        fallback={
          <Show when={video() ?? null} fallback={<Icon name={props.post.media ? "spinner-loader" : "video"} class={props.post.media ? "size-5 animate-spin" : "size-6"} />}>
            {(src) => <FrameStill src={src()} seconds={offset()} class="size-full object-cover" />}
          </Show>
        }
      >
        {(src) => <img src={src()} alt="" class="size-full object-cover" />}
      </Show>
    </div>
  );
}

function PostCard(props: { post: SocialPost; onOpen: () => void; onOpenProject?: () => void }) {
  const platforms = createMemo(() => {
    const seen = new Map<string, SocialPost["targets"][number]["status"] | null>();
    for (const t of props.post.targets) seen.set(t.platform, t.status);
    return [...seen.entries()];
  });
  const headline = () => {
    const caption = props.post.caption.trim();
    if (caption) return caption.split("\n")[0];
    const title = props.post.title?.trim();
    return title || "No caption yet";
  };
  return (
    <div
      role="button"
      tabIndex={0}
      class="flex w-full flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onOpen();
        }
      }}
    >
      <div class="flex items-start gap-3">
        <PostThumbnail post={props.post} />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <div class="flex items-center gap-2">
            <p class={cx("min-w-0 flex-1 truncate text-xs", props.post.caption.trim() || props.post.title?.trim() ? "text-foreground" : "text-muted-foreground")}>
              {headline()}
            </p>
            <Show when={props.onOpenProject}>
              <Button
                size="small"
                variant="ghost"
                class="text-muted-foreground"
                onClick={(e: MouseEvent) => {
                  e.stopPropagation();
                  props.onOpenProject!();
                }}
              >
                Open in project
              </Button>
            </Show>
            <StatusPill status={props.post.status} />
          </div>
          <p class="truncate text-muted-foreground text-xxs">
            {props.post.projectName ? `${props.post.projectName}${props.post.sceneId && props.post.sceneId !== "scene" ? ` · ${props.post.sceneId}` : ""} · ` : ""}
            {whenLabel(props.post)}
          </p>
          <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Show when={platforms().length === 0}>
              <span class="text-muted-foreground text-xxs">No accounts selected</span>
            </Show>
            <For each={platforms()}>
              {([platform, status]) => (
                <span
                  class="inline-flex items-center gap-1 rounded-sm bg-secondary px-1 py-0.5 text-xxs"
                  classList={{
                    "text-success-accent-foreground": status === "published",
                    "text-destructive": status === "failed",
                    "text-muted-foreground": status !== "published" && status !== "failed",
                  }}
                >
                  <Icon name={socialPlatformIcon(platform as never)} class="size-3" />
                </span>
              )}
            </For>
          </div>
        </div>
      </div>
      <Show when={props.post.status === "failed" || props.post.status === "partial"}>
        <p class="text-destructive text-xxs">
          {props.post.targets.find((t) => t.error)?.error ?? "Some destinations failed. Open to retry."}
        </p>
      </Show>
    </div>
  );
}

function ProjectPicker(props: { open: boolean; onClose: () => void; onPick: (project: ProjectInfo) => void }) {
  const [projects] = createResource(
    () => (props.open ? projectsRoot() : null),
    () => listProjects(),
  );
  const sorted = createMemo(() =>
    [...(projects() ?? [])].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)),
  );
  return (
    <DashboardFormModal
      open={props.open}
      title="Render a project to post"
      onClose={props.onClose}
      footer={
        <Button variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
      }
    >
      <p class="text-muted-foreground text-xs">
        The project opens in the editor, its active scene renders with its export settings, and the video attaches to a new post while you write the caption.
      </p>
      <div class="flex flex-col gap-1 pb-2">
        <Show when={!projects.loading} fallback={<Icon name="spinner-loader" class="size-5 animate-spin text-muted-foreground" />}>
          <Show when={sorted().length > 0} fallback={<p class="text-muted-foreground text-xs">No projects yet.</p>}>
            <For each={sorted()}>
              {(project) => (
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() => props.onPick(project)}
                >
                  <Icon name="compound-project-file" class="size-4 text-muted-foreground" />
                  <span class="min-w-0 flex-1 truncate">{project.displayName}</span>
                </button>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </DashboardFormModal>
  );
}

/**
 * Posts tab: every post grouped by what the user should do with it. Cards
 * open the composer; Create post either renders a project (through the
 * editor, the only place rendering can happen) or takes an MP4 from disk.
 */
export function DashboardPostsView() {
  const navigate = useNavigate();
  const social = useSocial();
  const posts = createQuery(socialPostsQuery);
  const accounts = createQuery(socialAccountsQuery);
  const [pickingProject, setPickingProject] = createSignal(false);
  // Drafts nothing was put into are noise; drop them whenever this tab opens.
  onMount(() => void pruneEmptyDrafts().catch(() => {}));

  const grouped = createMemo(() => {
    const groups: Record<PostSection, SocialPost[]> = { attention: [], upcoming: [], progress: [], drafts: [], published: [] };
    for (const post of posts().data ?? []) groups[postSection(post)].push(post);
    groups.upcoming.sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0));
    return groups;
  });
  const total = () => (posts().data ?? []).length;

  const chooseFile = async () => {
    if (window.desktop) {
      const picked = await pickVideoFile();
      if (picked) void social.startPostFromPath(picked.path, { projectName: picked.name });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void social.startPostFromFile(file, { projectName: file.name });
    };
    input.click();
  };
  const renderProject = () => {
    if (!window.desktop) {
      toast("Rendering needs the desktop app", { description: "Choose a video file to post from the browser." });
      return;
    }
    setPickingProject(true);
  };

  const createMenu = (
    <DropdownMenu placement="bottom-end">
      <DropdownMenuTrigger as={Button}>
        <Icon name="plus-add-small" class="size-4 mr-1" />
        Create post
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-56">
          <DropdownMenuItem onSelect={renderProject}>
            <Icon name="compound-project-file" class="size-4 mr-2" />
            Render from a project…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void chooseFile()}>
            <Icon name="video" class="size-4 mr-2" />
            Choose a video file…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-end gap-6 px-6 pt-4 pb-3">
        <div class="min-w-0 flex-1">
          <h1 class="text-2xl leading-6 font-450 text-foreground">Posts</h1>
          <p class="pt-1 text-muted-foreground text-xs">Scheduled and published videos across your connected accounts.</p>
        </div>
        {createMenu}
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-12">
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <Show when={posts().status === "error"}>
            <DashboardSurfaceCard>
              <p class="text-xs text-foreground">Posts are unavailable</p>
              <p class="text-muted-foreground text-xs">{posts().error?.message}</p>
            </DashboardSurfaceCard>
          </Show>
          <Show when={posts().status === "ready" && total() === 0}>
            <DashboardSurfaceCard class="flex flex-col gap-3">
              <p class="text-xs text-foreground">No posts yet</p>
              <p class="text-muted-foreground text-xs">
                Press Post in a project's Export panel to render and share a scene, or create a post here from a video file.
                <Show when={(accounts().data ?? []).length === 0}> Connect an account first in Settings → Connected accounts.</Show>
              </p>
              <div class="flex gap-2">
                {createMenu}
                <Show when={(accounts().data ?? []).length === 0}>
                  <Button variant="secondary" onClick={() => navigate("/?dashboard=settings")}>
                    Connect accounts
                  </Button>
                </Show>
              </div>
            </DashboardSurfaceCard>
          </Show>
          <For each={SECTIONS}>
            {(section) => (
              <Show when={grouped()[section.key].length > 0}>
                <section class="flex flex-col gap-2">
                  <h2 class="text-xs text-muted-foreground">
                    {section.title} · {grouped()[section.key].length}
                  </h2>
                  <div class="flex flex-col gap-2">
                    <For each={grouped()[section.key]}>
                      {(post) => (
                        <PostCard
                          post={post}
                          onOpen={() => social.openComposer(post.id)}
                          onOpenProject={
                            window.desktop && post.projectId && post.status === "draft" ? () => navigate(projectRoute(post.projectId!)) : undefined
                          }
                        />
                      )}
                    </For>
                  </div>
                </section>
              </Show>
            )}
          </For>
        </div>
      </div>
      <ProjectPicker
        open={pickingProject()}
        onClose={() => setPickingProject(false)}
        onPick={(project) => {
          setPickingProject(false);
          navigate(`${projectRoute(projectKey(project))}?post=1`);
        }}
      />
    </div>
  );
}
