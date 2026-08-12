const SUPPORTED = new Set(['$schema', 'type', 'description', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'additionalProperties', 'default', 'title', 'format', 'nullable']);

export function unsupportedSchemaKeywords(value: unknown, found = new Set<string>()): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [...found];
  for (const [key, child] of Object.entries(value)) {
    if (!SUPPORTED.has(key) && key !== 'properties') found.add(key);
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      for (const schema of Object.values(child)) unsupportedSchemaKeywords(schema, found);
    } else if (key === 'items') unsupportedSchemaKeywords(child, found);
  }
  return [...found];
}

