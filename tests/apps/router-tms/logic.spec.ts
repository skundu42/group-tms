import {getAddress} from "ethers";
import {
  runOnce,
  type Deps,
  type RunConfig,
  DEFAULT_BASE_GROUP_ADDRESS
} from "../../../src/apps/router-tms/logic";
import {
  FakeBlacklist,
  FakeCirclesRpc,
  FakeLogger,
  FakeRouterService
} from "../../../fakes/fakes";

const ROUTER_ADDRESS = "0xDC287474114cC0551a81DdC2EB51783fBF34802F";

let registerHumanPages: string[][] = [];

jest.mock("@circles-sdk/data", () => {
  class CirclesRpc {
    constructor(public readonly url: string) {}
  }

  class CirclesQuery<T> {
    currentPage: {results: T[]} | null = null;
    private pageIndex = 0;

    constructor(public readonly rpc: CirclesRpc, public readonly options: any) {}

    async queryNextPage(): Promise<boolean> {
      if (this.pageIndex >= registerHumanPages.length) {
        return false;
      }

      const avatars = registerHumanPages[this.pageIndex++];
      this.currentPage = {
        results: avatars.map((avatar, index) => ({
          avatar,
          blockNumber: 100 + index,
          transactionIndex: index,
          logIndex: index
        })) as unknown as T[]
      };
      return true;
    }
  }

  return {CirclesRpc, CirclesQuery};
});

function makeDeps(overrides?: Partial<Deps>): Deps {
  const circlesRpc = new FakeCirclesRpc();
  const blacklistingService = new FakeBlacklist();
  const logger = new FakeLogger(true);

  return {
    circlesRpc,
    blacklistingService,
    logger,
    ...overrides
  };
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    rpcUrl: "https://rpc.example",
    routerAddress: ROUTER_ADDRESS,
    baseGroupAddress: DEFAULT_BASE_GROUP_ADDRESS,
    dryRun: true,
    enableBatchSize: 25,
    fetchPageSize: 50,
    blacklistChunkSize: 50,
    ...overrides
  };
}

describe("router-tms runOnce", () => {
  beforeEach(() => {
    registerHumanPages = [];
  });

  it("throws when configured router address is invalid", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({routerAddress: "not-an-address"});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Invalid router address configured");
  });

  it("requires a router service when not running in dry-run mode", async () => {
    const deps = makeDeps();
    const cfg = makeConfig({dryRun: false});

    await expect(runOnce(deps, cfg)).rejects.toThrow("Router service dependency is required");
  });

  it("enables routing for every allowed non-blacklisted human avatar", async () => {
    const baseGroup = getAddress("0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026");
    const humanAlice = getAddress("0x2000000000000000000000000000000000000001");
    const humanBob = getAddress("0x2000000000000000000000000000000000000002");
    const humanCarol = getAddress("0x2000000000000000000000000000000000000003");

    registerHumanPages = [[humanAlice, humanBob], [humanAlice, humanCarol]];

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [humanAlice];

    const blacklistingService = new FakeBlacklist(new Set([humanCarol.toLowerCase()]));
    const routerService = new FakeRouterService(["0xtx_enable"]);

    const deps = makeDeps({
      circlesRpc,
      blacklistingService,
      routerService
    });

    const cfg = makeConfig({
      dryRun: false,
      enableBatchSize: 2,
      fetchPageSize: 2,
      blacklistChunkSize: 2,
      baseGroupAddress: baseGroup
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.totalAvatarEntries).toBe(4);
    expect(outcome.uniqueHumanCount).toBe(3);
    expect(outcome.allowedHumanCount).toBe(2);
    expect(outcome.blacklistedHumanCount).toBe(1);
    expect(outcome.alreadyTrustedCount).toBe(1);
    expect(outcome.pendingEnableCount).toBe(1);
    expect(outcome.executedEnableCount).toBe(1);
    expect(outcome.txHashes).toEqual(["0xtx_enable"]);

    expect(routerService.calls).toEqual([
      {baseGroup: baseGroup.toLowerCase(), crcAddresses: [humanBob.toLowerCase()]}
    ]);
  });

  it("returns pending avatars but skips execution in dry-run mode", async () => {
    const humanAlice = getAddress("0x2000000000000000000000000000000000000010");
    const humanBob = getAddress("0x2000000000000000000000000000000000000011");

    registerHumanPages = [[humanAlice, humanBob]];

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    const deps = makeDeps({circlesRpc});
    const cfg = makeConfig({dryRun: true});

    const outcome = await runOnce(deps, cfg);

    expect(outcome.pendingEnableCount).toBe(2);
    expect(outcome.executedEnableCount).toBe(0);
    expect(outcome.txHashes).toEqual([]);
  });
});
