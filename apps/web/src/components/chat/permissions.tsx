import type { RuntimeMode } from '@compound/chat/types';
import { ChatControlTooltip } from './control-tooltip';
import { Icon } from '@/components/ui/icon';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';

const modes: { value: RuntimeMode; label: string; description: string; icon: string }[] = [
  { value: 'approval-required', label: 'Supervised', description: 'Ask before commands and file changes.', icon: 'lock-closed' },
  { value: 'auto-accept-edits', label: 'Auto-accept edits', description: 'Auto-approve edits, ask before other actions.', icon: 'pencil' },
  { value: 'auto', label: 'Auto', description: 'Supported providers approve routine actions; others still ask.', icon: 'ai-generate' },
  { value: 'full-access', label: 'Full access', description: 'Allow commands and edits without prompts.', icon: 'lock-open' },
];
export function ChatPermissions(props: { value: RuntimeMode; disabled?: boolean; onChange: (value: RuntimeMode) => void }) {
  return <Select class="chat-permissions" options={modes} value={modes.find(mode => mode.value === props.value)} optionValue="value" optionTextValue="label" disabled={props.disabled} placement="top-start" onChange={mode => { if (mode) props.onChange(mode.value); }}
    itemComponent={item => <SelectItem item={item.item} class="h-auto py-2">
      <div class="whitespace-normal"><div class="flex items-center gap-1"><Icon name={item.item.rawValue.icon} class="size-4" /><span>{item.item.rawValue.label}</span></div><p class="mt-1 text-[11px] opacity-70 leading-normal">{item.item.rawValue.description}</p></div>
    </SelectItem>}>
    <ChatControlTooltip label={`${modes.find(mode => mode.value === props.value)?.label}: ${modes.find(mode => mode.value === props.value)?.description}`} >
    <SelectTrigger type="button" class="chat-permissions-trigger" aria-label={`Permissions: ${modes.find(mode => mode.value === props.value)?.label}`}>
      <SelectValue<typeof modes[number]>>{value => <><Icon name={value.selectedOption().icon} class="size-4" /><span class="chat-permissions-label">{value.selectedOption().label}</span></>}</SelectValue>
    </SelectTrigger>
    </ChatControlTooltip>
    <SelectPortal><SelectContent class="w-80 max-w-[calc(100vw-24px)]" /></SelectPortal>
  </Select>;
}
