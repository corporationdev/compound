/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// How hard the model thinks, when it advertises levels at all. The levels
// come from T3's model capabilities, so the picker only appears for models
// that have them, and the choice is remembered per model.

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

import type { ProviderOptionChoice, SelectProviderOptionDescriptor } from "@compound/chat/types";

type ThinkingPickerProps = {
  descriptor: SelectProviderOptionDescriptor;
  value: ProviderOptionChoice | undefined;
  disabled?: boolean;
  onSelect(value: string): void;
};

export function ThinkingPicker(props: ThinkingPickerProps) {
  const label = () => props.value?.label ?? "Default";
  return (
    <DropdownMenu placement="bottom-start">
      <DropdownMenuTrigger
        as="button"
        type="button"
        disabled={props.disabled}
        aria-label={`Thinking: ${label()}`}
        title={`Thinking: ${label()}${props.value?.description ? ` — ${props.value.description}` : ""}`}
        class="flex h-7 min-w-0 shrink items-center rounded-md pl-0.5 pr-2 text-xs font-450 text-muted-foreground hover:bg-muted focus-ring disabled:pointer-events-none disabled:opacity-40"
      >
        <span class="grid size-6 shrink-0 place-items-center overflow-clip">
          <Icon name="brain" class="size-[13px]" />
        </span>
        <span class="truncate">{label()}</span>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent class="w-56">
          <DropdownMenuGroup>
            <For each={props.descriptor.options}>
              {(option) => (
                <DropdownMenuItem class="h-auto items-start py-1.5" onSelect={() => props.onSelect(option.id)}>
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{option.label}</span>
                    <Show when={option.description}>
                      <span class="text-[11px] leading-4 text-muted-foreground whitespace-normal">{option.description}</span>
                    </Show>
                  </span>
                  <Show when={option.id === props.value?.id}>
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
