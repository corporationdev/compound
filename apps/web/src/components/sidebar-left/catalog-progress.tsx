export function CatalogProgress(props: { progress: number }) {
  return <svg viewBox="0 0 24 24" class="relative size-6" role="progressbar" aria-label="Estimated audio loading progress" aria-valuetext={props.progress === 1 ? 'Ready' : 'Preparing audio'}>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.5" />
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset={1 - Math.max(0.02, props.progress)} transform="rotate(-90 12 12)" class="transition-[stroke-dashoffset] duration-75 motion-reduce:transition-none" />
  </svg>;
}
