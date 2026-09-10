export const DEFAULT_SIDEBAR_WIDTH = 264;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 600;
export const MIN_CANVAS_WIDTH = 240;
const bounded = (value: number) => Number.isFinite(value) ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, value)) : DEFAULT_SIDEBAR_WIDTH;

/** Fit saved widths to this window without overwriting the user's preferred sizes. */
export function fitSidebarWidths(windowWidth: number, left: number, right: number) {
  left = bounded(left); right = bounded(right);
  const available = Math.max(MIN_SIDEBAR_WIDTH * 2, windowWidth - MIN_CANVAS_WIDTH - 2);
  if (left + right <= available) return { left, right };
  const extra = available - MIN_SIDEBAR_WIDTH * 2;
  const desiredExtra = left + right - MIN_SIDEBAR_WIDTH * 2;
  const leftExtra = desiredExtra ? Math.round(extra * (left - MIN_SIDEBAR_WIDTH) / desiredExtra) : 0;
  return { left: MIN_SIDEBAR_WIDTH + leftExtra, right: MIN_SIDEBAR_WIDTH + extra - leftExtra };
}
