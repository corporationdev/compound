import { expect, test } from 'bun:test';
import { compatibleModelOptions, setThinkingValue, thinkingDescriptor, thinkingValue } from '../src/thinking';
import type { ServerProviderModel } from '../src/upstream/contracts/index';

const model = (id: string): ServerProviderModel => ({ slug: 'test', name: 'Test', isCustom: false, capabilities: { optionDescriptors: [
  { id, label: 'Thinking', type: 'select', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', isDefault: true }, { id: 'ultrathink', label: 'Ultrathink' }], promptInjectedValues: ['ultrathink'] },
  { id: 'fastMode', label: 'Fast', type: 'boolean' },
] } });

test('thinking uses each provider’s capabilities and defaults, excluding prompt-only modes', () => {
  for (const id of ['reasoningEffort', 'effort']) {
    const descriptor = thinkingDescriptor(model(id))!;
    expect(descriptor.id).toBe(id);
    expect(descriptor.options.map(option => option.id)).toEqual(['low', 'high']);
    expect(thinkingValue(descriptor)?.id).toBe('high');
    expect(thinkingValue(descriptor, [{ id, value: 'low' }])?.id).toBe('low');
    expect(thinkingValue(descriptor, [{ id, value: 'unsupported' }])?.id).toBe('high');
  }
  expect(thinkingDescriptor({ ...model('effort'), capabilities: null })).toBeUndefined();
});

test('changing thinking preserves other options and switching models drops incompatible levels', () => {
  const options = setThinkingValue([{ id: 'fastMode', value: true }, { id: 'reasoningEffort', value: 'low' }], 'reasoningEffort', 'high');
  expect(options).toEqual([{ id: 'fastMode', value: true }, { id: 'reasoningEffort', value: 'high' }]);
  expect(compatibleModelOptions(model('effort'), options)).toEqual([{ id: 'fastMode', value: true }]);
});
