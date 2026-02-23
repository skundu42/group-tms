import { formatErrorWithCauses } from "../src/formatError";

describe("formatErrorWithCauses", () => {
  it("formats a basic Error with stack", () => {
    const err = new Error("something broke");
    const result = formatErrorWithCauses(err);
    expect(result).toContain("Error: something broke");
    expect(result).toContain("formatError.spec.ts"); // stack points here
  });

  it("formats an Error chain with .cause", () => {
    const root = new Error("root cause");
    const wrapper = new Error("wrapper", { cause: root });
    const result = formatErrorWithCauses(wrapper);
    expect(result).toContain("wrapper");
    expect(result).toContain("Caused by:");
    expect(result).toContain("root cause");
  });

  it("passes string cause through directly", () => {
    const err = new Error("oops", { cause: "plain string cause" });
    const result = formatErrorWithCauses(err);
    expect(result).toContain("plain string cause");
  });

  it("truncates non-Error cause beyond 10KB", () => {
    const bigObj: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      bigObj[`key_${i}`] = "x".repeat(200);
    }
    const err = new Error("fail", { cause: bigObj });
    const result = formatErrorWithCauses(err);

    // The cause portion (after "Caused by:\n") should be capped
    // Total result must be far below the 256KB Loki limit
    expect(result.length).toBeLessThan(50_000);
    expect(result).toContain("... [truncated]");
  });

  it("limits inspect depth to 2 for deeply nested objects", () => {
    const deep = { a: { b: { c: { d: { e: "deep" } } } } };
    const err = new Error("nested", { cause: deep });
    const result = formatErrorWithCauses(err);
    // depth 2 means c's value is shown as [Object] rather than expanded
    expect(result).toContain("[Object]");
    expect(result).not.toContain("'deep'");
  });

  it("handles circular cause chain", () => {
    const a = new Error("A");
    const b = new Error("B", { cause: a });
    (a as any).cause = b; // circular
    const result = formatErrorWithCauses(a);
    expect(result).toContain("[Circular cause elided]");
  });

  it("caps total output at 50KB", () => {
    // Build a long chain of errors to exceed 50KB
    let err: Error = new Error("base\n" + "x".repeat(20_000));
    for (let i = 0; i < 5; i++) {
      err = new Error(`layer-${i}\n` + "y".repeat(20_000), { cause: err });
    }
    const result = formatErrorWithCauses(err);
    expect(result.length).toBeLessThanOrEqual(50_000 + "... [truncated]".length + 1);
    expect(result).toContain("... [truncated]");
  });

  it("truncates long string properties via maxStringLength", () => {
    const obj = { payload: "A".repeat(5000) };
    const err = new Error("big payload", { cause: obj });
    const result = formatErrorWithCauses(err);
    // maxStringLength: 1000 means the 5000-char string is truncated in inspect output
    expect(result).not.toContain("A".repeat(5000));
    expect(result).toContain("... 4000 more characters");
  });

  it("handles null/undefined input gracefully", () => {
    expect(formatErrorWithCauses(null)).toBe("");
    expect(formatErrorWithCauses(undefined)).toBe("");
  });
});
