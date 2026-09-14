/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A month grid in the shape of shadcn's Calendar. Kobalte has no calendar
// primitive, so this is plain buttons over a computed grid. Dates are plain
// wall-clock triples: the caller decides which time zone they mean.

import { For, createMemo, createSignal } from "solid-js"

import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { cx } from "@/lib/cva"

export type CalendarDate = { year: number; month: number; day: number }

export const sameDate = (a: CalendarDate | null | undefined, b: CalendarDate | null | undefined) =>
  !!a && !!b && a.year === b.year && a.month === b.month && a.day === b.day
const compare = (a: CalendarDate, b: CalendarDate) => a.year - b.year || a.month - b.month || a.day - b.day

const WEEKDAYS = (() => {
  // 2023-01-01 was a Sunday; names come from the user's locale.
  const format = new Intl.DateTimeFormat(undefined, { weekday: "narrow", timeZone: "UTC" })
  return Array.from({ length: 7 }, (_, i) => format.format(Date.UTC(2023, 0, 1 + i)))
})()

export type CalendarProps = {
  value: CalendarDate | null
  onChange: (date: CalendarDate) => void
  /** Days before this cannot be chosen. */
  min?: CalendarDate
  /** Highlighted as today; defaults to the local calendar day. */
  today?: CalendarDate
  disabled?: boolean
  class?: string
}

export function Calendar(props: CalendarProps) {
  const today = () => {
    if (props.today) return props.today
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
  }
  const initial = props.value ?? today()
  const [view, setView] = createSignal({ year: initial.year, month: initial.month })

  const move = (delta: number) =>
    setView(({ year, month }) => {
      const index = year * 12 + (month - 1) + delta
      return { year: Math.floor(index / 12), month: (index % 12) + 1 }
    })

  const label = createMemo(() =>
    new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(view().year, view().month - 1, 1)),
  )

  // Six rows of seven, Sunday first, padded with the neighbouring months.
  const cells = createMemo(() => {
    const { year, month } = view()
    const first = new Date(Date.UTC(year, month - 1, 1))
    const offset = first.getUTCDay()
    return Array.from({ length: 42 }, (_, i) => {
      const date = new Date(Date.UTC(year, month - 1, 1 - offset + i))
      return {
        date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() } as CalendarDate,
        outside: date.getUTCMonth() !== month - 1,
      }
    })
  })

  const isDisabled = (date: CalendarDate) => !!props.disabled || (!!props.min && compare(date, props.min) < 0)

  return (
    <div data-slot="calendar" class={cx("flex w-fit flex-col gap-2 p-1", props.class)}>
      <div class="flex items-center justify-between">
        <Button variant="ghost" size="icon" type="button" aria-label="Previous month" disabled={props.disabled} onClick={() => move(-1)}>
          <Icon name="chevron-left" class="size-4" />
        </Button>
        <span class="text-xs text-foreground" aria-live="polite">
          {label()}
        </span>
        <Button variant="ghost" size="icon" type="button" aria-label="Next month" disabled={props.disabled} onClick={() => move(1)}>
          <Icon name="chevron-right" class="size-4" />
        </Button>
      </div>
      <div role="grid" class="grid grid-cols-7 gap-y-0.5">
        <For each={WEEKDAYS}>
          {(name) => (
            <span role="columnheader" class="flex h-6 w-7 items-center justify-center text-xxs text-muted-foreground">
              {name}
            </span>
          )}
        </For>
        <For each={cells()}>
          {(cell) => {
            const selected = () => sameDate(cell.date, props.value)
            const current = () => sameDate(cell.date, today())
            return (
              <button
                type="button"
                role="gridcell"
                aria-selected={selected()}
                aria-label={`${cell.date.year}-${String(cell.date.month).padStart(2, "0")}-${String(cell.date.day).padStart(2, "0")}`}
                disabled={isDisabled(cell.date)}
                onClick={() => {
                  setView({ year: cell.date.year, month: cell.date.month })
                  props.onChange(cell.date)
                }}
                class={cx(
                  "flex size-7 items-center justify-center rounded-md text-xs outline-none transition-colors",
                  "focus-visible:ring-[1px] focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-30",
                  selected()
                    ? "bg-primary text-primary-foreground hover:bg-primary-hover"
                    : cx("text-foreground hover:bg-accent", cell.outside && "text-muted-foreground/60"),
                  current() && !selected() && "ring-[1px] ring-inset ring-border",
                )}
              >
                {cell.date.day}
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
