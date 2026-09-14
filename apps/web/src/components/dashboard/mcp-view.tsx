/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Match, Show, Switch, createResource, createSignal, onCleanup } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchCliStatus, fetchMcpStatus, installCli, uninstallCli } from "@/lib/mcp";
import { isDesktop } from "@/projects";

import {
  DashboardInfoActionRow,
  DashboardScrollView,
  DashboardSurfaceCard,
  DashboardSurfaceSection,
  DashboardTitledSection,
} from "./shared";

const MCP_DOCS_URL = "https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers";

// --- MCP server --------------------------------------------------------------

const COPIED_LABEL_MS = 2000;

function DashboardMcpServerSection() {
  const [status] = createResource(fetchMcpStatus);
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  const copy = async () => {
    const url = status()?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      // The button itself says so for a moment, then goes back to its label.
      setCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
    } catch (e) {
      toast.error("Failed to copy", { description: (e as Error).message });
    }
  };

  return (
    <DashboardTitledSection title="MCP Server">
      <DashboardSurfaceCard class="flex flex-col gap-3">
        <DashboardInfoActionRow
          layout="inline"
          leadingSize="sm"
          title="Compound MCP"
          leading={<Icon name="ai-mcp-cli" class="text-foreground" />}
          description="Connect any other agent that supports MCP over Streamable HTTP."
          action={
            <div class="flex shrink-0 items-center gap-2">
              <div class="flex h-7 w-41 items-center rounded-md bg-input px-2">
                <span class="min-w-0 flex-1 truncate text-xs text-foreground">{status()?.url ?? "..."}</span>
              </div>
              <Button variant="secondary" disabled={!status()} onClick={copy}>
                {copied() ? "Copied!" : "Copy URL"}
              </Button>
            </div>
          }
        />
      </DashboardSurfaceCard>
      <p class="px-2 pt-3 text-xs text-muted-foreground">
        <span>Available locally while Compound is running. </span>
        <a href={MCP_DOCS_URL} target="_blank" class="text-primary hover:underline">
          What is MCP?
        </a>
      </p>
    </DashboardTitledSection>
  );
}

// --- CLI ---------------------------------------------------------------------

function DashboardCliSection() {
  const [status, { refetch }] = createResource(fetchCliStatus);
  const [busy, setBusy] = createSignal(false);

  const handleInstall = async () => {
    setBusy(true);
    try {
      const result = await installCli();
      if (result.status === "installed") toast("CLI installed", { description: "Run compound --help in a terminal to get started." });
      if (result.status === "error") toast.error("Could not install the CLI", { description: result.error });
    } catch (e) {
      toast.error("Could not install the CLI", { description: (e as Error).message });
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    try {
      const result = await uninstallCli();
      if (result.status === "removed") toast("CLI uninstalled");
      if (result.status === "error") toast.error("Could not uninstall the CLI", { description: result.error });
    } catch (e) {
      toast.error("Could not uninstall the CLI", { description: (e as Error).message });
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  return (
    <DashboardSurfaceSection
      title="CLI"
      description="Give agents access to Compound through terminal commands."
    >
      <DashboardInfoActionRow
        layout="inline"
        leadingSize="sm"
        title="compound CLI"
        leading={<Icon name="compound-cli" class="text-foreground" />}
        description="Compound’s command-line tool for accessing its media tools and managing projects."
        action={
          <Switch>
            <Match when={!status()}>
              <Button variant="secondary" disabled>
                Install
              </Button>
            </Match>
            <Match when={status()?.installed && status()?.managed}>
              <Tooltip>
                <TooltipTrigger as={Button} variant="secondary" disabled={busy()} onClick={handleUninstall}>
                  Uninstall
                </TooltipTrigger>
                <TooltipContent>Installed at {status()?.path}</TooltipContent>
              </Tooltip>
            </Match>
            <Match when={status()?.installed}>
              <Tooltip>
                <TooltipTrigger as={Button} variant="on">
                  Installed
                </TooltipTrigger>
                <TooltipContent>Found at {status()?.path}. Not a link, so it is left alone.</TooltipContent>
              </Tooltip>
            </Match>
            <Match when={true}>
              <Button variant="secondary" disabled={busy()} onClick={handleInstall}>
                Install
              </Button>
            </Match>
          </Switch>
        }
      />
    </DashboardSurfaceSection>
  );
}

export function DashboardMcpView() {
  return (
    <DashboardScrollView>
      <Show
        when={isDesktop()}
        fallback={
          <DashboardSurfaceSection title="MCP & CLI">
            <p class="text-xs text-muted-foreground">
              The MCP server and the command line tool are available in the desktop app.
            </p>
          </DashboardSurfaceSection>
        }
      >
        <DashboardMcpServerSection />
        <DashboardCliSection />
      </Show>
    </DashboardScrollView>
  );
}
