import {getAddress} from "ethers";
import {runOnce, type Deps, type RunConfig} from "../../../src/apps/gp-crc/logic";
import {FakeAvatarSafeService, FakeBlacklist, FakeChainRpc, FakeCirclesRpc, FakeGroupService, FakeLogger} from "../../../fakes/fakes";

const RPC_URL = "https://rpc.stub";

function makeDeps(overrides?: Partial<Deps>): Deps {
  const chainRpc = new FakeChainRpc({blockNumber: 0, timestamp: 0});
  const blacklistingService = new FakeBlacklist();
  const logger = new FakeLogger(true);
  const groupService = new FakeGroupService();
  const avatarSafeService = new FakeAvatarSafeService();
  const circlesRpc = new FakeCirclesRpc();

  return {
    chainRpc,
    blacklistingService,
    avatarSafeService,
    circlesRpc,
    groupService,
    logger,
    ...overrides
  };
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    rpcUrl: RPC_URL,
    startAtBlock: 0,
    confirmationBlocks: 0,
    blockChunkSize: 50_000,
    blacklistChunkSize: 100,
    groupAddress: "0x1000000000000000000000000000000000000000",
    ...overrides
  };
}

class FlakyGroupService extends FakeGroupService {
  attempts = 0;

  constructor(private readonly failuresBeforeSuccess: number, private readonly errorCode: string) {
    super();
  }

  override async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      const error = new Error("temporary trust failure");
      (error as any).code = this.errorCode;
      throw error;
    }

    return super.trustBatchWithConditions(groupAddress, trusteeAddresses);
  }
}

class FlakyBlacklistService extends FakeBlacklist {
  attempts = 0;

  constructor(private readonly failuresBeforeSuccess: number, private readonly errorCode: string) {
    super();
  }

  override async checkBlacklist(addresses: string[]) {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      const error = new Error("temporary blacklist failure");
      (error as any).code = this.errorCode;
      throw error;
    }

    return super.checkBlacklist(addresses);
  }
}

describe("gp-crc runOnce", () => {
  const realFetch = globalThis.fetch as any;

  afterEach(() => {
    if (realFetch) {
      globalThis.fetch = realFetch;
    } else {
      // @ts-expect-error fetch may be undefined in older Node versions
      delete globalThis.fetch;
    }
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("skips processing when the safe head is behind the configured start block", async () => {
    const chainRpc = new FakeChainRpc({blockNumber: 108, timestamp: 0});
    const deps = makeDeps({chainRpc});
    const cfg = makeConfig({
      startAtBlock: 200,
      confirmationBlocks: 10
    });

    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.processed).toBe(false);
    expect(outcome.newLastProcessedBlock).toBe(98);
    expect(outcome.eventCount).toBe(0);
    expect(outcome.uniqueAvatarCount).toBe(0);
    expect(outcome.allowedAvatars).toEqual([]);
    expect(outcome.blacklistedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("throws when configured group address is invalid", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({groupAddress: "not-an-address"});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Invalid group address configured");
  });

  it("requires group service when not running in dry-run mode", async () => {
    const deps = makeDeps({groupService: undefined});
    const cfg = makeConfig();

    await expect(runOnce(deps, cfg)).rejects.toThrow("Group service dependency is required");
  });

  it("returns allowed and blacklisted avatars for fetched events", async () => {
    const allowedInput = "0xaaaa000000000000000000000000000000000000";
    const blockedInput = "0xbbbb000000000000000000000000000000000000";
    const allowed = getAddress(allowedInput);
    const blocked = getAddress(blockedInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const blacklistingService = new FakeBlacklist(new Set([blockedInput]));
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, blacklistingService, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: allowedInput},
            transactionHash: "0x1"
          },
          {
            blockNumber: 142,
            values: {avatar: blockedInput},
            transactionHash: "0x2"
          },
          {
            blockNumber: 143,
            values: {avatar: allowedInput},
            transactionHash: "0x3"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.processed).toBe(true);
    expect(outcome.eventCount).toBe(3);
    expect(outcome.uniqueAvatarCount).toBe(2);
    expect(outcome.allowedAvatars).toEqual([allowed]);
    expect(outcome.blacklistedAvatars).toEqual([blocked]);
    expect(outcome.trustedAvatars).toEqual([allowed]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    expect(outcome.newLastProcessedBlock).toBe(145);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0]).toEqual({
      type: "trust",
      groupAddress: cfg.groupAddress,
      trusteeAddresses: [allowed]
    });
  });

  it("skips avatars that are already trusted in the group", async () => {
    const alreadyTrustedInput = "0x1111000000000000000000000000000000000000";
    const newAvatarInput = "0x2222000000000000000000000000000000000000";
    const alreadyTrusted = getAddress(alreadyTrustedInput);
    const newAvatar = getAddress(newAvatarInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const circlesRpc = new FakeCirclesRpc();
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, circlesRpc, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    circlesRpc.trusteesByTruster[cfg.groupAddress.toLowerCase()] = [alreadyTrustedInput];

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: alreadyTrustedInput},
            transactionHash: "0x1"
          },
          {
            blockNumber: 142,
            values: {avatar: newAvatarInput},
            transactionHash: "0x2"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([alreadyTrusted, newAvatar]);
    expect(outcome.trustedAvatars).toEqual([newAvatar]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0]).toEqual({
      type: "trust",
      groupAddress: cfg.groupAddress,
      trusteeAddresses: [newAvatar]
    });
  });

  it("skips allowed avatars without configured safes", async () => {
    const withSafeInput = "0x1111000000000000000000000000000000000000";
    const withoutSafeInput = "0x2222000000000000000000000000000000000000";
    const withSafe = getAddress(withSafeInput);
    const withoutSafe = getAddress(withoutSafeInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const avatarSafeService = new FakeAvatarSafeService({
      [withSafeInput]: "0xsafe1111"
    });
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, avatarSafeService, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: withSafeInput},
            transactionHash: "0x1"
          },
          {
            blockNumber: 142,
            values: {avatar: withoutSafeInput},
            transactionHash: "0x2"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([withSafe, withoutSafe]);
    expect(outcome.trustedAvatars).toEqual([withSafe]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0]).toEqual({
      type: "trust",
      groupAddress: cfg.groupAddress,
      trusteeAddresses: [withSafe]
    });
  });

  it("splits fetch requests according to blockChunkSize", async () => {
    const chainRpc = new FakeChainRpc({blockNumber: 20, timestamp: 0});
    const deps = makeDeps({chainRpc});
    const cfg = makeConfig({
      startAtBlock: 10,
      confirmationBlocks: 1,
      blockChunkSize: 2
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({result: []})
    });
    globalThis.fetch = fetchMock as any;

    await runOnce(deps, cfg);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const payloads = fetchMock.mock.calls.map(([, init]) => {
      const body = (init as any).body as string;
      return JSON.parse(body);
    });
    expect(payloads[0].params[1]).toBe(10);
    expect(payloads[0].params[2]).toBe(11);
    expect(payloads[payloads.length - 1].params[1]).toBe(18);
    expect(payloads[payloads.length - 1].params[2]).toBe(19);
  });

  it("supports dry-run mode by skipping on-chain trust calls", async () => {
    const avatarInput = "0xcccc000000000000000000000000000000000000";
    const avatar = getAddress(avatarInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10,
      dryRun: true
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: avatarInput},
            transactionHash: "0x1"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([avatar]);
    expect(outcome.trustedAvatars).toEqual([avatar]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    expect(groupService.calls).toHaveLength(0);
  });

  it("logs dry-run untrust batches when stale trustees remain", async () => {
    const staleInput = "0xdddd000000000000000000000000000000000000";
    const stale = getAddress(staleInput);
    const activeInput = "0xeeee000000000000000000000000000000000000";
    const active = getAddress(activeInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const avatarSafeService = new FakeAvatarSafeService({
      [activeInput]: "0xsafe_active"
    });
    const circlesRpc = new FakeCirclesRpc();

    const deps = makeDeps({chainRpc, avatarSafeService, circlesRpc});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10,
      dryRun: true,
      groupBatchSize: 1
    });

    circlesRpc.trusteesByTruster[cfg.groupAddress.toLowerCase()] = [staleInput];

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: activeInput},
            transactionHash: "0x1"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([active]);
    expect(outcome.trustedAvatars).toEqual([active]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([stale]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("accepts mixed-case avatar addresses", async () => {
    const uppercase = "0xAAAA000000000000000000000000000000000000";
    const expected = getAddress(uppercase);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: uppercase},
            transactionHash: "0x1"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([expected]);
    expect(outcome.trustedAvatars).toEqual([expected]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0]).toEqual({
      type: "trust",
      groupAddress: cfg.groupAddress,
      trusteeAddresses: [expected]
    });
  });

  it("retries fetching register human events after a retryable HTTP failure", async () => {
    jest.useFakeTimers();

    const avatarInput = "0xffff000000000000000000000000000000000000";
    const avatar = getAddress(avatarInput);

    const chainRpc = new FakeChainRpc({blockNumber: 50, timestamp: 0});
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, groupService});
    const cfg = makeConfig({
      startAtBlock: 40,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error"
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          result: [
            {
              blockNumber: 41,
              values: {avatar: avatarInput},
              transactionHash: "0x1"
            }
          ]
        })
      });
    globalThis.fetch = fetchMock as any;

    const outcomePromise = runOnce(deps, cfg);
    await jest.advanceTimersByTimeAsync(2_000);
    const outcome = await outcomePromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.eventCount).toBe(1);
    expect(outcome.allowedAvatars).toEqual([avatar]);
    expect(outcome.trustedAvatars).toEqual([avatar]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("retries trust batches on retryable errors before succeeding", async () => {
    jest.useFakeTimers();

    const avatarInput = "0xdddd000000000000000000000000000000000000";
    const avatar = getAddress(avatarInput);
    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const groupService = new FlakyGroupService(1, "NETWORK_ERROR");
    const deps = makeDeps({chainRpc, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: avatarInput},
            transactionHash: "0x1"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcomePromise = runOnce(deps, cfg);
    await jest.runOnlyPendingTimersAsync();
    const outcome = await outcomePromise;

    expect(groupService.attempts).toBe(2);
    expect(outcome.allowedAvatars).toEqual([avatar]);
    expect(outcome.trustedAvatars).toEqual([avatar]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("fails fast when trust batch throws non-retryable error", async () => {
    const avatarInput = "0xeeee000000000000000000000000000000000000";
    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const groupService = new FlakyGroupService(1, "CALL_EXCEPTION");
    const deps = makeDeps({chainRpc, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: avatarInput},
            transactionHash: "0x1"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    await expect(runOnce(deps, cfg)).rejects.toThrow("temporary trust failure");
    expect(groupService.attempts).toBe(1);
  });

  it("retries blacklist checks on retryable errors", async () => {
    jest.useFakeTimers();

    const avatarInput = "0xffff111100000000000000000000000000000000";
    const avatar = getAddress(avatarInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const blacklistingService = new FlakyBlacklistService(1, "NETWORK_ERROR");
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, blacklistingService, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: [
          {
            blockNumber: 141,
            values: {avatar: avatarInput},
            transactionHash: "0x1"
          }
        ]
      })
    });
    globalThis.fetch = fetchMock as any;

    const outcomePromise = runOnce(deps, cfg);
    await jest.advanceTimersByTimeAsync(2_000);
    const outcome = await outcomePromise;

    expect(blacklistingService.attempts).toBe(2);
    expect(outcome.allowedAvatars).toEqual([avatar]);
    expect(outcome.trustedAvatars).toEqual([avatar]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("untrusts avatars that become blacklisted", async () => {
    const avatarInput = "0x4444000000000000000000000000000000000000";
    const avatar = getAddress(avatarInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const circlesRpc = new FakeCirclesRpc();
    const blacklistingService = new FakeBlacklist(new Set([avatarInput.toLowerCase()]));
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, circlesRpc, blacklistingService, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    circlesRpc.trusteesByTruster[cfg.groupAddress.toLowerCase()] = [avatarInput];

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({result: []})
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([]);
    expect(outcome.blacklistedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([avatar]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
    expect(groupService.calls).toEqual([
      {
        type: "untrust",
        groupAddress: cfg.groupAddress,
        trusteeAddresses: [avatar]
      }
    ]);
  });

  it("untrusts avatars that no longer have an associated safe", async () => {
    const avatarInput = "0x5555000000000000000000000000000000000000";
    const avatar = getAddress(avatarInput);

    const chainRpc = new FakeChainRpc({blockNumber: 150, timestamp: 0});
    const circlesRpc = new FakeCirclesRpc();
    const avatarSafeService = new FakeAvatarSafeService({});
    const groupService = new FakeGroupService();
    const deps = makeDeps({chainRpc, circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig({
      startAtBlock: 140,
      confirmationBlocks: 5,
      blockChunkSize: 10,
      blacklistChunkSize: 10
    });

    circlesRpc.trusteesByTruster[cfg.groupAddress.toLowerCase()] = [avatarInput];

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({result: []})
    });
    globalThis.fetch = fetchMock as any;

    const outcome = await runOnce(deps, cfg);

    expect(outcome.allowedAvatars).toEqual([]);
    expect(outcome.blacklistedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([avatar]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
    expect(groupService.calls).toEqual([
      {
        type: "untrust",
        groupAddress: cfg.groupAddress,
        trusteeAddresses: [avatar]
      }
    ]);
  });
});
