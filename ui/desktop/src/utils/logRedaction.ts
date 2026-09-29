/**
 * Masks key values in the arguments of a log call before any transport writes them
 * (requirement 1.10). Strings are masked in place. Anything else (errors, objects) is rendered
 * the way the log would show it and replaced by the masked text only when it holds a key, so
 * ordinary log lines keep their formatting.
 */
import { inspect } from 'node:util';
import { redactText } from './secretMask';

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // `inspect` covers error stacks, causes and nested properties, and copes with cycles.
  const rendered = inspect(value, { depth: 8 });
  const masked = redactText(rendered, secrets);
  return masked === rendered ? value : masked;
}

export function redactLogData(data: readonly unknown[], secrets: readonly string[]): unknown[] {
  if (secrets.length === 0) {
    return [...data];
  }
  return data.map((item) => redactValue(item, secrets));
}
