/** Collapse labels only when their actual rendered widths no longer fit. */
export function observeComposerLayout(footer: HTMLDivElement) {
  let frame = 0;
  const measure = () => {
    frame = 0;
    const available = footer.clientWidth;
    if (!available) return;
    // Measure a hidden copy so long model names and permission labels count at
    // their natural width, even when the visible controls are already compact.
    const probe = footer.cloneNode(true) as HTMLDivElement;
    probe.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    probe.setAttribute('aria-hidden', 'true');
    probe.inert = true;
    probe.dataset.measuring = '';
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: `${available}px` });
    footer.parentElement!.append(probe);
    let compact = 'all';
    for (const mode of ['none', 'permissions', 'thinking', 'all']) {
      probe.dataset.compact = mode;
      if (probe.scrollWidth <= available) { compact = mode; break; }
    }
    probe.remove();
    footer.dataset.compact = compact;
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const content = new MutationObserver(schedule);
  resize.observe(footer);
  content.observe(footer, { childList: true, characterData: true, subtree: true });
  schedule();
  return () => { resize.disconnect(); content.disconnect(); cancelAnimationFrame(frame); };
}
