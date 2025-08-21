// Always replace global fetch with a fresh mock so tests can use .mockResolvedValueOnce(...)
beforeEach(() => {
  (globalThis as any).fetch = jest.fn();

  console.info = jest.fn();
  console.warn = jest.fn();
  console.error = jest.fn();
  console.debug = jest.fn();
  (console as any).table = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
