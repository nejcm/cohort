export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: false;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  oneOf?: readonly JsonSchema[];
  description?: string;
};

// Supports exactly the keywords above; unknown keywords in a schema are ignored, so keep schemas within this subset.
export function validate(schema: JsonSchema, value: unknown, path = '$'): string | null {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((option) => validate(option, value, path) === null).length;
    return matches === 1 ? null : `${path}: must match exactly one schema (matched ${matches})`;
  }
  if ('const' in schema && value !== schema.const) return `${path}: must equal ${JSON.stringify(schema.const)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path}: must be one of ${schema.enum.join(', ')}`;
  switch (schema.type) {
    case 'null':
      return value === null ? null : `${path}: must be null`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${path}: must be a list`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path}: too few items`;
      if (!schema.items) return null;
      for (const [index, item] of value.entries()) {
        const error = validate(schema.items, item, `${path}[${index}]`);
        if (error) return error;
      }
      return null;
    }
    case 'string':
      if (typeof value !== 'string') return `${path}: must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${path}: too short`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path}: too long`;
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return `${path}: does not match pattern`;
      return null;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: must be a number`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${path}: must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below minimum`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above maximum`;
      return null;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path}: must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in record)) return `${path}.${key}: required`;
      for (const [key, item] of Object.entries(record)) {
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false) return `${path}.${key}: unknown property`;
          continue;
        }
        const error = validate(property, item, `${path}.${key}`);
        if (error) return error;
      }
      return null;
    }
    default:
      return null;
  }
}
