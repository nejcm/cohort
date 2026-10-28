const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/gu;
const MIN_SECRET_LENGTH = 4;

export class SecretError extends Error {
  override name = 'SecretError';
}

export class SecretStore {
  private readonly byName = new Map<string, string>();

  bind(name: string, value: string): string {
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new SecretError(`invalid secret name: ${name}`);
    // Very short values would redact ordinary text and cannot be masked meaningfully.
    if (value.length < MIN_SECRET_LENGTH) throw new SecretError(`secret ${name} is shorter than ${MIN_SECRET_LENGTH}`);
    this.byName.set(name, value);
    return `{{${name}}}`;
  }

  get values(): string[] {
    return [...this.byName.values()];
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }

  hasPlaceholder(text: string): boolean {
    return new RegExp(PLACEHOLDER.source, 'u').test(text);
  }

  substitute(text: string): string {
    return text.replace(PLACEHOLDER, (_, name: string) => {
      const value = this.byName.get(name);
      if (value === undefined) throw new SecretError(`unknown secret placeholder: {{${name}}}`);
      return value;
    });
  }

  contains(text: string): boolean {
    return this.values.some((value) => text.includes(value));
  }

  redact(text: string): string {
    const entries = [...this.byName].toSorted((a, b) => b[1].length - a[1].length);
    return entries.reduce((result, [name, value]) => result.split(value).join(`{{${name}}}`), text);
  }
}

/** Origin and path only; queries and fragments may carry credentials. */
export function safeUrl(url: string, secrets: SecretStore): string {
  try {
    const parsed = new URL(url);
    return secrets.redact(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return '[invalid url]';
  }
}
