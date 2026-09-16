/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";

import { DashboardAccountView } from "@/components/dashboard/account-view";
import { DashboardGetDesktopApp } from "@/components/dashboard/get-desktop-app";
import { DashboardHelpView } from "@/components/dashboard/help-view";
import { DashboardHomeView } from "@/components/dashboard/home-view";
import { DashboardMcpView } from "@/components/dashboard/mcp-view";
import { DashboardProjectsView } from "@/components/dashboard/projects-view";
import { DashboardSettingsView } from "@/components/dashboard/settings-view";
import { DashboardSidebarUser } from "@/components/dashboard/sidebar-user-menu";
import {
  DashboardSidebarHeader,
  DashboardSidebarItem,
  DashboardSidebarNav,
  DashboardSidebarSection,
  DashboardSidebarTopSpacer,
} from "@/components/dashboard/sidebar";
import { Separator } from "@/components/ui/separator";
import { WorkspaceFileTree } from "@/components/workspace/file-tree";
import { WorkspaceView } from "@/components/workspace/workspace-view";
import { useFullscreenState } from "@/hooks/use-fullscreen-state";
import { isDesktop, openProjectFolder, pickProjectFolder } from "@/projects";
import { isInputTarget } from "@/utils";

import type { DashboardView } from "@/components/dashboard/types";

const DASHBOARD_VIEWS: readonly DashboardView[] = [
  "home",
  "projects",
  "workspace",
  "account",
  "settings",
  "mcp",
  "help",
];

/** The views reached through the settings navigation, not the dashboard one. */
const SETTINGS_VIEWS: readonly DashboardView[] = [
  "account",
  "settings",
  "mcp",
  "help",
];

function parseView(value: string | string[] | undefined): DashboardView {
  const raw = Array.isArray(value) ? value[0] : value;
  return DASHBOARD_VIEWS.find((v) => v === raw) ?? "home";
}

function isSettingsView(view: DashboardView): boolean {
  return SETTINGS_VIEWS.includes(view);
}

/** The `/workspace/*path` segment, decoded; '' at the workspace root. */
function decodePath(raw: string | undefined): string {
  if (!raw) return "";
  return raw.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join("/");
}

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const routeParams = useParams<{ path?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const isFullscreen = useFullscreenState();

  // ⌘I: the native folder picker, and the chosen folder on the recents list.
  let picking = false;
  const handleShortcut = async (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    if (event.key.toLowerCase() !== "i" || isInputTarget(event)) return;

    event.preventDefault();
    if (picking || !isDesktop()) return;
    picking = true;

    try {
      const dir = await pickProjectFolder();
      if (!dir) return;
      await openProjectFolder(dir);
    } catch (e) {
      toast.error("Failed to add project", { description: (e as Error).message });
    } finally {
      picking = false;
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleShortcut);
    onCleanup(() => window.removeEventListener("keydown", handleShortcut));
  });

  // A workspace file is its own route (so it can be linked and restored);
  // the other views are a query param on the dashboard route.
  const onWorkspaceRoute = createMemo(() => location.pathname.startsWith("/workspace"));
  const workspacePath = createMemo(() => (onWorkspaceRoute() ? decodePath(routeParams.path) : null));
  const view = (): DashboardView => (onWorkspaceRoute() ? "workspace" : parseView(params.dashboard));
  const setView = (next: DashboardView) => {
    if (onWorkspaceRoute()) navigate(`/?dashboard=${next}`, { replace: true });
    else setParams({ dashboard: next }, { replace: true });
  };

  // Which navigation the sidebar shows. Landing on a settings view (deep link,
  // reload) opens the settings navigation; the user row opens it by itself.
  const [settingsNavOpen, setSettingsNavOpen] = createSignal(isSettingsView(view()));

  createEffect(() => {
    if (isSettingsView(view())) {
      setSettingsNavOpen(true);
    }
  });

  const openProfile = () => {
    setSettingsNavOpen(true);
    setView("account");
  };
  const backToDashboard = () => {
    setSettingsNavOpen(false);
    if (isSettingsView(view())) setView("home");
  };

  return (
    <div class="flex h-screen w-full min-h-0 flex-row overflow-hidden bg-sidebar">
      <aside class="relative flex min-h-0 w-69 shrink-0 flex-col">
        <Show when={!!window.desktop && !isFullscreen()}>
          <div class="absolute inset-x-0 top-0 h-10 z-20" style="-webkit-app-region: drag;" />
        </Show>
        <Show when={!settingsNavOpen()} fallback={<DashboardSidebarTopSpacer />}>
          <DashboardSidebarHeader />
        </Show>
        <DashboardSidebarNav fill={!settingsNavOpen() && isDesktop()}>
          <Show
            when={settingsNavOpen()}
            fallback={
              <>
                <DashboardSidebarSection>
                  <DashboardSidebarItem active={view() === "home"} onClick={() => setView("home")} icon="home" label="Home" />
                  <DashboardSidebarItem active={view() === "projects"} onClick={() => setView("projects")} icon="compound-project-file" label="Projects" />
                </DashboardSidebarSection>
                <Show when={isDesktop()}>
                  <WorkspaceFileTree selectedPath={workspacePath()} />
                </Show>
              </>
            }
          >
            <DashboardSidebarSection>
              <DashboardSidebarItem onClick={backToDashboard} icon="arrow-left" label="Back to dashboard" />
            </DashboardSidebarSection>
            <DashboardSidebarSection title="Settings">
              <DashboardSidebarItem active={view() === "account"} onClick={() => setView("account")} icon="user" label="Account" />
              <DashboardSidebarItem active={view() === "settings"} onClick={() => setView("settings")} icon="settings" label="General" />
              <DashboardSidebarItem active={view() === "mcp"} onClick={() => setView("mcp")} icon="ai-mcp-cli" label="MCP & CLI" />
              <DashboardSidebarItem active={view() === "help"} onClick={() => setView("help")} icon="help" label="Help" />
            </DashboardSidebarSection>
          </Show>
        </DashboardSidebarNav>
        <DashboardSidebarUser
          onAccount={openProfile}
          onSwitch={() => {
            // File paths belong to the previous organization. Start at home
            // instead of opening the same path in the newly selected workspace.
            if (onWorkspaceRoute()) setView("home");
          }}
        />
      </aside>

      <Separator orientation="vertical" class="bg-border-strong" />

      <section class="flex min-h-0 flex-1 flex-col bg-overlay-soft">
        <Switch>
          <Match when={view() === "home"}>
            <DashboardHomeView />
          </Match>
          <Match when={view() === "projects"}>
            <DashboardProjectsView />
          </Match>
          <Match when={view() === "workspace"}>
            <WorkspaceView path={workspacePath() ?? ""} />
          </Match>
          <Match when={view() === "account"}>
            <DashboardAccountView />
          </Match>
          <Match when={view() === "settings"}>
            <DashboardSettingsView />
          </Match>
          <Match when={view() === "mcp"}>
            <DashboardMcpView />
          </Match>
          <Match when={view() === "help"}>
            <DashboardHelpView />
          </Match>
        </Switch>
        <DashboardGetDesktopApp />
      </section>
    </div>
  );
}
