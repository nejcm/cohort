/** Locale or time zone values this runtime's `Intl` rejects, as `source.field: message` errors; browser-safe. */
export function localeProblems(persona: { locale?: unknown; timezone?: unknown }, source: string): string[] {
  const problems: string[] = [];
  try {
    if (typeof persona.locale === 'string') Intl.getCanonicalLocales(persona.locale);
  } catch {
    problems.push(`${source}.locale: unsupported locale ${persona.locale as string}`);
  }
  try {
    if (typeof persona.timezone === 'string') Intl.DateTimeFormat('en', { timeZone: persona.timezone });
  } catch {
    problems.push(`${source}.timezone: unsupported time zone ${persona.timezone as string}`);
  }
  return problems;
}
