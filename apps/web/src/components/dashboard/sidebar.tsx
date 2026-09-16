/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, type JSX } from "solid-js";
import { Icon } from "@/components/ui/icon";
import { cx } from "@/lib/cva";

type DashboardSidebarItemProps = {
  icon: string;
  label: string;
  active?: boolean;
  onClick?(): void;
  class?: string;
};

export function DashboardSidebarItem(props: DashboardSidebarItemProps) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={cx(
        "my-0.5 flex h-7 w-full shrink-0 items-center gap-1 rounded-md pl-0 pr-1 hover:bg-accent focus-ring",
        props.class,
      )}
      classList={{ "bg-accent": props.active }}
    >
      <span class="grid size-7 shrink-0 place-items-center overflow-clip">
        <Show
          when={props.active}
          fallback={<Icon name={props.icon} class="size-6 text-muted-foreground" />}
        >
          <Icon name={props.icon} class="size-6 text-foreground" />
        </Show>
      </span>
      <span
        class="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground"
        classList={{ "text-foreground": props.active }}
      >
        {props.label}
      </span>
    </button>
  );
}

export function DashboardSidebarHeader() {
  return (
    // Extra top padding on the macOS desktop build clears the traffic lights
    // (hiddenInset title bar), except in fullscreen where they are gone.
    <div class="flex flex-col items-start gap-3 p-4 [[data-platform=darwin]:not([data-fullscreen=true])_&]:pt-14">
      <Icon name="compound-logo" class="size-6 text-muted-foreground" />
      <div class="flex w-full flex-col items-start gap-1 text-muted-foreground">
        <p class="w-full text-2xl leading-5 font-450 text-muted-foreground">
          Compound
        </p>
        <div class="flex w-full items-center py-0.5">
          <p class="w-full overflow-hidden text-xxs whitespace-nowrap text-ellipsis text-muted-foreground opacity-50">
            v{APP_VERSION}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Stands in for the header when the sidebar has none. On the macOS desktop
 * build it clears the traffic lights (hiddenInset title bar), except in
 * fullscreen where they are gone.
 */
export function DashboardSidebarTopSpacer() {
  return <div class="h-4 shrink-0 [[data-platform=darwin]:not([data-fullscreen=true])_&]:h-12" />;
}

type DashboardSidebarNavProps = {
  children: JSX.Element;
  footer?: JSX.Element;
  /** The last child takes the remaining height (a tree that scrolls) instead of empty space. */
  fill?: boolean;
};

/** The middle of the sidebar: stacked sections, then empty space — or a section that fills it. */
export function DashboardSidebarNav(props: DashboardSidebarNavProps) {
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-3">
      {props.children}
      <Show when={!props.fill}>
        <div class="min-h-0 flex-1" />
      </Show>
      {props.footer}
    </div>
  );
}


type DashboardSidebarSectionProps = {
  title?: string;
  children: JSX.Element;
};

export function DashboardSidebarSection(props: DashboardSidebarSectionProps) {
  return (
    <div class="flex shrink-0 flex-col">
      <Show when={props.title}>
        <div class="flex h-8 shrink-0 items-center px-1">
          <p class="text-xs text-muted-foreground">{props.title}</p>
        </div>
      </Show>
      {props.children}
    </div>
  );
}
