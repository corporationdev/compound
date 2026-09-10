import { createMemo } from 'solid-js';
import type { ServerProvider } from '@compound/chat/types';
import { Icon } from '@/components/ui/icon';
import { Select, SelectContent, SelectItem, SelectPortal, SelectSection, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChatControlTooltip } from './control-tooltip';

type ModelOption = { value: string; label: string; provider: 'codex' | 'claudeAgent'; model: string };
type ModelGroup = { label: string; options: ModelOption[] };
const label = (provider: string) => provider === 'claudeAgent' ? 'Claude Code' : 'Codex';
const icon = (provider: string) => provider === 'claudeAgent' ? 'provider-claude' : 'provider-codex';

export function ChatModelPicker(props: { provider: string; model: string; providers: readonly ServerProvider[]; providerLocked: boolean; disabled?: boolean; onChange: (provider: ModelOption['provider'], model: string) => void }) {
  const groups = createMemo<ModelGroup[]>(() => (['codex', 'claudeAgent'] as const)
    .filter(id => !props.providerLocked || id === props.provider)
    .map(id => {
      const provider = props.providers.find(p => p.instanceId === id);
      const models = provider?.models.length ? provider.models : [{ slug: '', name: label(id) }];
      return { label: label(id), options: models.map(model => ({ value: `${id}:${model.slug}`, label: model.name, provider: id, model: model.slug })) };
    }));
  const selected = () => groups().flatMap(group => group.options).find(option => option.provider === props.provider && option.model === props.model);
  const modelLabel = () => selected()?.label || props.model || 'Choose model';
  return <Select<ModelOption, ModelGroup> class="chat-model-picker" options={groups()} value={selected() ?? null} optionValue="value" optionTextValue="label" optionGroupChildren="options" placement="top-start" disabled={props.disabled} onChange={option => { if (option) props.onChange(option.provider, option.model); }}
    sectionComponent={section => <SelectSection>{section.section.rawValue.label}</SelectSection>}
    itemComponent={item => <SelectItem item={item.item}><span class="flex items-center gap-2"><Icon name={icon(item.item.rawValue.provider)} class="size-[13px]" />{item.item.rawValue.label}</span></SelectItem>}>
    <ChatControlTooltip label={`${label(props.provider)} · ${modelLabel()}${props.providerLocked ? ' — Start a new chat to change providers.' : ''}`}>
      <SelectTrigger type="button" class="chat-model-trigger" aria-label={`Model: ${label(props.provider)}, ${modelLabel()}`}>
        <Icon name={icon(props.provider)} class="chat-provider-icon" />
        <SelectValue<ModelOption> class="chat-model-label">{() => modelLabel()}</SelectValue>
      </SelectTrigger>
    </ChatControlTooltip>
    <SelectPortal><SelectContent class="min-w-56 max-w-[calc(100vw-24px)]" /></SelectPortal>
  </Select>;
}
