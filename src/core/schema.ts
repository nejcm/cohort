export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  uniqueItems?: boolean;
  oneOf?: readonly JsonSchema[];
  description?: string;
};

// Supports exactly the keywords above; unknown keywords in a schema are ignored, so keep schemas within this subset.
export function validate(schema: JsonSchema, value: unknown, path = '$'): string | null {
  return schemaProblems(schema, value, path)[0] ?? null;
}

/** Every problem, not only the first; a value of the wrong type yields one problem and is not descended into. */
export function schemaProblems(schema: JsonSchema, value: unknown, path = '$'): string[] {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => schemaProblems(option, value, path).length === 0).length;
    if (matches !== 1) return [`${path}: must match exactly one schema (matched ${matches})`];
  }
  if ('const' in schema && value !== schema.const) return [`${path}: must equal ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.join(', ')}`];
  switch (schema.type) {
    case 'null':
      return value === null ? [] : [`${path}: must be null`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: must be a boolean`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: must be a list`];
      const found: string[] = [];
      if (schema.minItems !== undefined && value.length < schema.minItems) found.push(`${path}: too few items`);
      if (schema.items)
        for (const [index, item] of value.entries())
          found.push(...schemaProblems(schema.items, item, `${path}[${index}]`));
      const repeat = schema.uniqueItems ? value.findIndex((item, index) => value.indexOf(item) !== index) : -1;
      if (repeat !== -1) found.push(`${path}[${repeat}]: duplicate ${JSON.stringify(value[repeat])}`);
      return found;
    }
    case 'string':
      if (typeof value !== 'string') return [`${path}: must be a string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) return [`${path}: too short`];
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path}: too long`];
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return [`${path}: does not match pattern`];
      return [];
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: must be a number`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path}: must be an integer`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: below minimum`];
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: above maximum`];
      return [];
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: must be an object`];
      const record = value as Record<string, unknown>;
      const found = (schema.required ?? [])
        .filter((key) => !Object.hasOwn(record, key))
        .map((key) => `${path}.${key}: required`);
      for (const [key, item] of Object.entries(record)) {
        const property =
          schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (property) found.push(...schemaProblems(property, item, `${path}.${key}`));
        else if (schema.additionalProperties === false) found.push(`${path}.${key}: unknown property`);
      }
      return found;
    }
    default:
      return [];
  }
}
