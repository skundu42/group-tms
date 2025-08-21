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
      parts.push(typeof current === "string" ? current : inspect(current, {depth: 5}));
    }
    break;
  }

  if (current && seen.has(current)) {
    parts.push("[Circular cause elided]");
  }

  return parts.join("\n");
}

