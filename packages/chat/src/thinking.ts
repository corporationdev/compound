import type { ProviderOptionSelections, SelectProviderOptionDescriptor, ServerProviderModel } from './upstream/contracts/index';

/** Use the provider's advertised levels; prompt-only modes need separate UI support. */
export function thinkingDescriptor(model: ServerProviderModel | undefined): SelectProviderOptionDescriptor | undefined {
  const descriptor = model?.capabilities?.optionDescriptors?.find((option): option is SelectProviderOptionDescriptor => option.type === 'select' && ['reasoningEffort', 'effort'].includes(option.id));
  if (!descriptor) return;
  const options = descriptor.options.filter(option => !descriptor.promptInjectedValues?.includes(option.id));
  return options.length ? { ...descriptor, options } : undefined;
}

export function thinkingValue(descriptor: SelectProviderOptionDescriptor, selections: ProviderOptionSelections = []) {
  const saved = selections.find(option => option.id === descriptor.id)?.value;
  return descriptor.options.find(option => option.id === saved)
    ?? descriptor.options.find(option => option.id === descriptor.currentValue)
    ?? descriptor.options.find(option => option.isDefault)
    ?? descriptor.options[0];
}

export function setThinkingValue(options: ProviderOptionSelections, id: string, value: string): ProviderOptionSelections {
  return [...options.filter(option => option.id !== id), { id, value }];
}

/** Drop incompatible saved levels when the user changes models. */
export function compatibleModelOptions(model: ServerProviderModel | undefined, options: ProviderOptionSelections): ProviderOptionSelections {
  return options.filter(option => model?.capabilities?.optionDescriptors?.some(descriptor => descriptor.id === option.id && (descriptor.type === 'boolean' ? typeof option.value === 'boolean' : descriptor.options.some(choice => choice.id === option.value) && !descriptor.promptInjectedValues?.includes(String(option.value)))));
}
