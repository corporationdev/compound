import { thinkingValue } from '@compound/chat';
import type { ProviderOptionChoice, ProviderOptionSelections, SelectProviderOptionDescriptor } from '@compound/chat/types';
import { Icon } from '@/components/ui/icon';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChatControlTooltip } from './control-tooltip';

export function ChatThinkingPicker(props: { descriptor: SelectProviderOptionDescriptor; options: ProviderOptionSelections; disabled?: boolean; onChange: (value: string) => void }) {
  const selected = () => thinkingValue(props.descriptor, props.options);
  return <Select<ProviderOptionChoice> class="chat-thinking" options={[...props.descriptor.options]} value={selected()} optionValue="id" optionTextValue="label" placement="top-start" disabled={props.disabled} onChange={option => { if (option) props.onChange(option.id); }}
    itemComponent={item => <SelectItem item={item.item} class="h-auto py-2"><div><span>{item.item.rawValue.label}</span><p class="whitespace-normal text-[11px] opacity-70">{item.item.rawValue.description}</p></div></SelectItem>}>
    <ChatControlTooltip label={`Thinking: ${selected()?.label ?? 'Default'}${selected()?.description ? ` — ${selected()!.description}` : ''}`}>
      <SelectTrigger type="button" class="chat-thinking-trigger" aria-label={`Thinking: ${selected()?.label ?? 'Default'}`}>
        <Icon name="brain" class="size-[14px]" />
        <SelectValue<ProviderOptionChoice> class="chat-thinking-label">{() => selected()?.label ?? 'Default'}</SelectValue>
      </SelectTrigger>
    </ChatControlTooltip>
    <SelectPortal><SelectContent class="min-w-40 max-w-[calc(100vw-24px)]" /></SelectPortal>
  </Select>;
}
