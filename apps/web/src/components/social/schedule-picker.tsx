/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, createEffect, createMemo, createSignal } from "solid-js";

import { Button } from "@/components/ui/button";
import { Calendar, type CalendarDate } from "@/components/ui/calendar";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "@/components/ui/popover";
import { cx } from "@/lib/cva";
import { formatPostTime, fromLocalInputValue, toLocalInputValue } from "@/lib/social";

/** Minutes between selectable times. */
export const SCHEDULE_STEP_MINUTES = 15;
type TimeOption = { minutes: number; label: string };

/** The next instant on the schedule grid at or after `instant`. */
export function snapToScheduleGrid(instant: number): number {
  const step = SCHEDULE_STEP_MINUTES * 60_000;
  return Math.ceil(instant / step) * step;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Wall-clock parts of an instant in a zone, via the `datetime-local` shape already used for posts. */
function wallClock(instant: number, timezone: string): { date: CalendarDate; minutes: number } {
  const [date, time] = toLocalInputValue(instant, timezone).split("T") as [string, string];
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return { date: { year, month, day }, minutes: hour * 60 + minute };
}
function instantOf(date: CalendarDate, minutes: number, timezone: string): number {
  const value = `${date.year}-${pad(date.month)}-${pad(date.day)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return fromLocalInputValue(value, timezone) ?? Date.now();
}

/**
 * Date and time for a scheduled post, in the post's time zone. A calendar
 * plus a time list in 15 minute steps; the value is always an instant, so
 * the rest of the composer never sees wall-clock strings. Plain buttons, no
 * select primitive: nothing here fires a change the caller did not click.
 */
export function SchedulePicker(props: { value: number | null; timezone: string; disabled?: boolean; onChange: (instant: number) => void }) {
  const [open, setOpen] = createSignal(false);
  const current = createMemo(() => wallClock(props.value ?? Date.now(), props.timezone));
  const now = createMemo(() => wallClock(Date.now(), props.timezone));

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const labelFor = (minutes: number) => timeFormat.format(Date.UTC(2023, 0, 1, Math.floor(minutes / 60), minutes % 60));
  const times: TimeOption[] = Array.from({ length: (24 * 60) / SCHEDULE_STEP_MINUTES }, (_, i) => ({
    minutes: i * SCHEDULE_STEP_MINUTES,
    label: labelFor(i * SCHEDULE_STEP_MINUTES),
  }));
  // A saved time off the grid (an older post) is shown as its own row.
  const options = createMemo(() => {
    const minutes = current().minutes;
    return times.some((t) => t.minutes === minutes) ? times : [...times, { minutes, label: labelFor(minutes) }].sort((a, b) => a.minutes - b.minutes);
  });

  const change = (instant: number) => {
    if (instant !== props.value) props.onChange(instant);
  };
  const pickDate = (date: CalendarDate) => change(instantOf(date, current().minutes, props.timezone));
  const pickTime = (minutes: number) => change(instantOf(current().date, minutes, props.timezone));

  // Scroll the chosen time into view each time the popover opens.
  let list: HTMLDivElement | undefined;
  createEffect(() => {
    if (!open()) return;
    queueMicrotask(() => list?.querySelector<HTMLElement>("[aria-pressed='true']")?.scrollIntoView({ block: "center" }));
  });

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-start">
      <PopoverTrigger as={Button} variant="outline" class="w-fit gap-1.5 font-normal" disabled={props.disabled}>
        <Icon name="posts" class="size-4 text-muted-foreground" />
        <span>{props.value !== null ? formatPostTime(props.value, props.timezone) : "Pick a date and time"}</span>
        <Icon name="chevron-down" class="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent class="z-[10000] w-auto p-2">
          <div class="flex gap-3">
            <Calendar value={current().date} min={now().date} today={now().date} disabled={props.disabled} onChange={pickDate} />
            <div class="flex w-28 flex-col gap-1.5 border-l border-border pl-3">
              <span class="text-xxs text-muted-foreground">Time · {props.timezone}</span>
              <div ref={list} class="flex max-h-64 flex-col gap-0.5 overflow-y-auto pr-1" role="listbox" aria-label="Time">
                <For each={options()}>
                  {(option) => {
                    const selected = () => option.minutes === current().minutes;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected()}
                        aria-pressed={selected()}
                        disabled={props.disabled}
                        onClick={() => pickTime(option.minutes)}
                        class={cx(
                          "flex h-7 shrink-0 items-center rounded-md px-2 text-xs outline-none transition-colors",
                          "focus-visible:ring-[1px] focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-30",
                          selected() ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-accent",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
