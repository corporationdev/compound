import { createSignal, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';

/** Thin editor divider with a wider invisible hit area, shared across panel axes. */
export function PanelResizeHandle(props: {
  label: string; axis: 'x' | 'y'; value: number; min: number; max: number;
  reverse?: boolean; defaultValue: number; onChange: (value: number) => void;
  style?: JSX.CSSProperties;
}) {
  const [active, setActive] = createSignal(false);
  let drag: { pointer: number; position: number; value: number; element: HTMLDivElement; cursor: string; select: string } | undefined;
  const change = (value: number) => props.onChange(Math.round(Math.max(props.min, Math.min(props.max, value))));
  const end = () => {
    if (!drag) return;
    const previous = drag; drag = undefined; setActive(false);
    document.documentElement.style.cursor = previous.cursor;
    document.documentElement.style.userSelect = previous.select;
    window.removeEventListener('blur', end);
    if (previous.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer);
  };
  onCleanup(end);
  return <div role="separator" aria-label={props.label} aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(props.value)} aria-valuemin={props.min} aria-valuemax={Math.round(props.max)} tabIndex={0}
    class="absolute z-40 group outline-none touch-none"
    classList={{ 'top-0 bottom-0 w-[5px] -translate-x-1/2 cursor-ew-resize': props.axis === 'x', 'left-0 right-0 h-[5px] -translate-y-1/2 cursor-ns-resize': props.axis === 'y' }}
    style={{ '-webkit-app-region': 'no-drag', ...props.style }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); end(); event.currentTarget.focus();
      drag = { pointer: event.pointerId, position: props.axis === 'x' ? event.clientX : event.clientY, value: props.value, element: event.currentTarget, cursor: document.documentElement.style.cursor, select: document.documentElement.style.userSelect };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.documentElement.style.cursor = props.axis === 'x' ? 'ew-resize' : 'ns-resize';
      document.documentElement.style.userSelect = 'none';
      setActive(true); window.addEventListener('blur', end);
    }}
    onPointerMove={event => {
      if (!drag || event.pointerId !== drag.pointer) return;
      const position = props.axis === 'x' ? event.clientX : event.clientY;
      change(drag.value + (position - drag.position) * (props.reverse ? -1 : 1));
    }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDblClick={() => change(props.defaultValue)}
    onKeyDown={event => {
      const decrement = props.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const increment = props.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (![decrement, increment, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') change(props.min);
      else if (event.key === 'End') change(props.max);
      else change(props.value + (event.key === increment ? 1 : -1) * (props.reverse ? -1 : 1) * (event.shiftKey ? 40 : 10));
    }}>
    <div class="absolute transition-colors group-hover:bg-primary group-focus-visible:bg-primary" classList={{ 'bg-primary': active(), 'top-0 bottom-0 left-[2px] w-px': props.axis === 'x', 'left-0 right-0 top-[2px] h-px': props.axis === 'y' }} />
  </div>;
}
