/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How much the agent may do without asking. T3 runs every turn under one of
// four runtime modes; a chat carries its own, a draft carries the project's
// remembered choice. The trigger sits in the composer next to the model.

import { For, Show } from "solid-js";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";

import type { RuntimeMode } from "@compound/chat/types";

export const PERMISSION_MODES: { value: RuntimeMode; label: string; description: string; icon: string }[] = [
  { value: "approval-required", label: "Supervised", description: "Ask before commands and file changes.", icon: "lock-closed" },
  { value: "auto-accept-edits", label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions.", icon: "pencil" },
  { value: "auto", label: "Auto", description: "Supported agents approve routine actions; others still ask.", icon: "ai-generate" },
  { value: "full-access", label: "Full access", description: "Allow commands and edits without prompts.", icon: "lock-open" },
];

type PermissionPickerProps = {
  value: RuntimeMode;
  disabled?: boolean;
  onSelect(value: RuntimeMode): void;
};

export function PermissionPicker(props: PermissionPickerProps) {
  const current = () => PERMISSION_MODES.find((mode) => mode.value === props.value) ?? PERMISSION_MODES[0]!;
  return (
    <DropdownMenu placement="bottom-start">
      <DropdownMenuTrigger
        as="button"
        type="button"
        disabled={props.disabled}
        aria-label={`Permissions: ${current().label}`}
        title={`${current().label} — ${current().description}`}
        class="flex h-7 min-w-0 shrink items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-muted focus-ring disabled:pointer-events-none disabled:opacity-40"
      >
        <span class="grid size-6 shrink-0 place-items-center overflow-clip">
          <Icon name={current().icon} />
        </span>
        <span class="truncate">{current().label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-64">
          <DropdownMenuGroup>
            <For each={PERMISSION_MODES}>
              {(mode) => (
                <DropdownMenuItem class="h-auto items-start py-1.5" onSelect={() => props.onSelect(mode.value)}>
                  <Icon name={mode.icon} class="mt-0.5" />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{mode.label}</span>
                    <span class="text-[11px] leading-4 text-muted-foreground whitespace-normal">{mode.description}</span>
                  </span>
                  <Show when={mode.value === props.value}>
                    <Icon name="confirm-check" class="mt-0.5 size-6 shrink-0" />
                  </Show>
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
