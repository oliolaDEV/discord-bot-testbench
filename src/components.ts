type Component = Record<string, any>;

export function componentTree(components: readonly Component[]): Component[] {
  return components.flatMap(component => [component, ...componentTree([
    ...(component.components ?? []),
    ...(component.component ? [component.component] : []),
    ...(component.accessory ? [component.accessory] : [])
  ])]);
}

export function componentText(components: readonly Component[]) {
  return componentTree(components).filter(component => component.type === 10).map(component => component.content ?? '').join('\n');
}

export function modalComponents(fields: Record<string, string>, inputs: readonly Component[]) {
  let id = 0;
  const legacy = Object.entries(fields).map(([custom_id, value]) => ({ type: 1, id: ++id, components: [{ type: 4, id: ++id, custom_id, value }] }));
  const modern = inputs.map(field => {
    const { customId, ...value } = field;
    return { type: 18, id: ++id, component: { ...value, id: ++id, custom_id: customId } };
  });
  return [...legacy, ...modern];
}

export function validateModal(definition: Component, submitted: Component[], resolved: Component) {
  const values = new Map(componentTree(submitted).filter(component => component.custom_id).map(component => [component.custom_id, component]));
  const definitions = componentTree(definition.components ?? []).filter(component => component.custom_id);
  const known = new Set(definitions.map(component => component.custom_id));
  for (const id of values.keys()) if (!known.has(id)) throw new Error(`Unknown modal field: ${id}`);
  for (const field of definitions) {
    const input = values.get(field.custom_id);
    if (!input) throw new Error(`Missing modal field: ${field.custom_id}`);
    if (input.type !== field.type) throw new Error(`Modal field type does not match: ${field.custom_id}`);
    if (field.type === 4) {
      const min = field.min_length ?? (field.required === false ? 0 : 1);
      if (input.value.length < min || input.value.length > (field.max_length ?? 4000)) throw new Error(`Text length is outside modal field limits: ${field.custom_id}`);
    }
    if (field.type === 21) {
      if (input.value === null && field.required !== false) throw new Error(`Radio selection is required: ${field.custom_id}`);
      if (input.value !== null && !field.options.some((option: Component) => option.value === input.value)) throw new Error(`Unknown radio option: ${field.custom_id}`);
    }
    if ([3, 5, 6, 7, 8, 19, 22].includes(field.type)) {
      const min = field.min_values ?? (field.required === false ? 0 : 1);
      const max = field.max_values ?? (field.type === 22 ? field.options.length : 1);
      if (input.values.length < min || input.values.length > max) throw new Error(`Selection count is outside modal field limits: ${field.custom_id}`);
      if (new Set(input.values).size !== input.values.length) throw new Error(`Duplicate modal selection: ${field.custom_id}`);
      if ([3, 22].includes(field.type) && input.values.some((value: string) => !field.options.some((option: Component) => option.value === value))) throw new Error(`Unknown modal selection: ${field.custom_id}`);
      if (field.type === 8 && field.channel_types?.length && input.values.some((value: string) => !field.channel_types.includes(resolved.channels[value]?.type))) throw new Error(`Selected channel type is not allowed: ${field.custom_id}`);
    }
  }
}
