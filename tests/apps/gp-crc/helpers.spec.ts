import {__testables} from "../../../src/apps/gp-crc/logic";

const {timedFetch} = __testables;

describe("gp-crc helpers", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("aborts fetches that exceed the timeout", async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    jest.useFakeTimers();
    const fetchPromise = timedFetch("https://rpc.stub", {method: "POST"}, 500);
    const expectation = expect(fetchPromise).rejects.toThrow("aborted");

    await jest.advanceTimersByTimeAsync(500);
    await expectation;
  });
});
