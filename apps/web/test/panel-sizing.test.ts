import { expect, test } from 'bun:test';
import { fitSidebarWidths, MIN_CANVAS_WIDTH } from '../src/lib/panel-sizing';
test('preserves independently sized sidebars when there is room', () => {
  expect(fitSidebarWidths(1400, 300, 480)).toEqual({ left: 300, right: 480 });
});
test('shrinking a window preserves canvas space and sidebar minimums', () => {
  for (const width of [720, 900, 1100]) {
    const panels = fitSidebarWidths(width, 600, 500);
    expect(panels.left).toBeGreaterThanOrEqual(220);
    expect(panels.right).toBeGreaterThanOrEqual(220);
    expect(width - panels.left - panels.right - 2).toBeGreaterThanOrEqual(MIN_CANVAS_WIDTH);
  }
});
test('invalid saved widths are bounded', () => {
  expect(fitSidebarWidths(1600, NaN, -10)).toEqual({ left: 264, right: 220 });
  expect(fitSidebarWidths(1600, 900, 900)).toEqual({ left: 600, right: 600 });
});
