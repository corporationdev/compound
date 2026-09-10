import type { JSX } from 'solid-js';
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip';

export function ChatControlTooltip(props: { label: string; children: JSX.Element }) {
  return <Tooltip><TooltipTrigger as="div" tabIndex={-1} class="chat-control-tooltip">{props.children}</TooltipTrigger><TooltipPortal><TooltipContent class="max-w-72">{props.label}</TooltipContent></TooltipPortal></Tooltip>;
}
