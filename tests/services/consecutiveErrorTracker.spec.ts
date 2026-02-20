import {ConsecutiveErrorTracker} from "../../src/services/consecutiveErrorTracker";

describe("ConsecutiveErrorTracker", () => {
  it("starts with count 0 and should not alert", () => {
    const tracker = new ConsecutiveErrorTracker(3);
    expect(tracker.getCount()).toBe(0);
    expect(tracker.shouldAlert()).toBe(false);
  });

  it("increments on recordError and returns new count", () => {
    const tracker = new ConsecutiveErrorTracker(3);
    expect(tracker.recordError()).toBe(1);
    expect(tracker.recordError()).toBe(2);
    expect(tracker.getCount()).toBe(2);
  });

  it("alerts once threshold is reached", () => {
    const tracker = new ConsecutiveErrorTracker(3);
    tracker.recordError();
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(false);
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(true);
  });

  it("continues to alert above threshold", () => {
    const tracker = new ConsecutiveErrorTracker(2);
    tracker.recordError();
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(true);
    tracker.recordError(); // 3 > 2
    expect(tracker.shouldAlert()).toBe(true);
  });

  it("resets count to 0 on recordSuccess", () => {
    const tracker = new ConsecutiveErrorTracker(3);
    tracker.recordError();
    tracker.recordError();
    expect(tracker.getCount()).toBe(2);
    tracker.recordSuccess();
    expect(tracker.getCount()).toBe(0);
    expect(tracker.shouldAlert()).toBe(false);
  });

  it("requires full threshold again after a success resets the count", () => {
    const tracker = new ConsecutiveErrorTracker(3);
    // Get to 2 errors, then succeed
    tracker.recordError();
    tracker.recordError();
    tracker.recordSuccess();
    // Need 3 fresh consecutive errors to alert
    tracker.recordError();
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(false);
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(true);
  });

  it("uses default threshold of 3 when none provided", () => {
    const tracker = new ConsecutiveErrorTracker();
    tracker.recordError();
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(false);
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(true);
  });

  it("works with threshold of 1 (alert on first error)", () => {
    const tracker = new ConsecutiveErrorTracker(1);
    expect(tracker.shouldAlert()).toBe(false);
    tracker.recordError();
    expect(tracker.shouldAlert()).toBe(true);
  });
});
