import {inspect} from "node:util";

/**
 * Formats an Error and its .cause chain. Falls back to string/inspect for non-Error values.
 */
export function formatErrorWithCauses(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current != null && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      const stack = typeof current.stack === "string" && current.stack.length > 0
        ? current.stack
        : `${current.name}: ${current.message}`;
      parts.push(stack);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cause: unknown = (current as any).cause;
      if (cause) {
        parts.push("Caused by:");
        current = cause;
        continue;
      }
    } else {
      const MAX_CAUSE_LENGTH = 10_000;
      const raw = typeof current === "string"
        ? current
        : inspect(current, { depth: 2, maxStringLength: 1000, breakLength: 120 });
      parts.push(raw.length > MAX_CAUSE_LENGTH ? raw.slice(0, MAX_CAUSE_LENGTH) + "\n... [truncated]" : raw);
    }
    break;
  }

  if (current && seen.has(current)) {
    parts.push("[Circular cause elided]");
  }

  const MAX_TOTAL_LENGTH = 50_000;
  const result = parts.join("\n");
  return result.length > MAX_TOTAL_LENGTH ? result.slice(0, MAX_TOTAL_LENGTH) + "\n... [truncated]" : result;
}

