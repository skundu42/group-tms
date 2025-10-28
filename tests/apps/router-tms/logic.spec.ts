import {getAddress} from "ethers";
import {runOnce, type Deps, type RunConfig} from "../../../src/apps/router-tms/logic";
import {FakeCirclesRpc, FakeLogger, FakeRouterService} from "../../../fakes/fakes";

const ROUTER_ADDRESS = "0xDC287474114cC0551a81DdC2EB51783fBF34802F";

const getAvatarInfoBatchMock = jest.fn();

jest.mock("@circles-sdk/data", () => {
  class CirclesData {
    constructor(public readonly rpcUrl: string) {}

    getAvatarInfoBatch(...args: unknown[]) {
      return getAvatarInfoBatchMock(...args);
    }
  }

  return {CirclesData};
});

function makeDeps(overrides?: Partial<Deps>): Deps {
  const circlesRpc = new FakeCirclesRpc();
  const logger = new FakeLogger(true);

  return {
    circlesRpc,
    logger,
    ...overrides
  };
}

function makeConfig(overrides?: Partial<RunConfig>): RunConfig {
  return {
    rpcUrl: "https://rpc.example",
    routerAddress: ROUTER_ADDRESS,
    dryRun: true,
    enableBatchSize: 25,
    baseGroupPageSize: 50,
    avatarInfoBatchSize: 50,
    ...overrides
  };
}


describe("router-tms runOnce", () => {
  beforeEach(() => {
    getAvatarInfoBatchMock.mockReset();
    getAvatarInfoBatchMock.mockResolvedValue([]);
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

  it("trusts every human CRC trusted by base groups and calls enableCRCForRouting", async () => {
    const baseGroupOne = getAddress("0x1000000000000000000000000000000000000001");
    const baseGroupTwo = getAddress("0x1000000000000000000000000000000000000002");

    const humanAlice = getAddress("0x2000000000000000000000000000000000000001");
    const humanBob = getAddress("0x2000000000000000000000000000000000000002");
    const orgTreasury = getAddress("0x3000000000000000000000000000000000000003");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.baseGroups = [baseGroupOne, baseGroupTwo];
    circlesRpc.trusteesByTruster[baseGroupOne.toLowerCase()] = [humanAlice, orgTreasury, ROUTER_ADDRESS];
    circlesRpc.trusteesByTruster[baseGroupTwo.toLowerCase()] = [humanAlice, humanBob, ROUTER_ADDRESS];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [humanAlice];

    const humanSet = new Set([humanAlice.toLowerCase(), humanBob.toLowerCase()]);
    getAvatarInfoBatchMock.mockImplementation(async (avatars: string[]) => {
      return avatars.map((avatar) => {
        const lower = avatar.toLowerCase();
        const isHuman = humanSet.has(lower);
        return {
          avatar,
          isHuman,
          version: isHuman ? 2 : 1
        };
      });
    });

    const routerService = new FakeRouterService();
    const deps = makeDeps({circlesRpc, routerService});
    const cfg = makeConfig({
      dryRun: false,
      avatarInfoBatchSize: 10
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.baseGroupCount).toBe(2);
    expect(outcome.humanTrustCount).toBe(2);
    expect(outcome.routerTrustCount).toBe(2);
    expect(outcome.pendingTrustCount).toBe(1);
    expect(outcome.executedTrustCount).toBe(1);
    expect(outcome.txHashes).toEqual(["0xtx_1"]);
    expect(outcome.plans).toEqual([
      {baseGroup: baseGroupTwo.toLowerCase(), addresses: [humanBob.toLowerCase()]}
    ]);
    expect(routerService.calls).toEqual([
      {baseGroup: baseGroupTwo.toLowerCase(), crcAddresses: [humanBob.toLowerCase()]}
    ]);
    expect(getAvatarInfoBatchMock).toHaveBeenCalledTimes(1);
  });

  it("skips human avatars that are not v2 before enabling routing", async () => {
    const baseGroup = getAddress("0x1000000000000000000000000000000000000004");
    const humanV1 = getAddress("0x2000000000000000000000000000000000000005");
    const humanV2 = getAddress("0x2000000000000000000000000000000000000006");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.baseGroups = [baseGroup];
    circlesRpc.trusteesByTruster[baseGroup.toLowerCase()] = [humanV1, humanV2, ROUTER_ADDRESS];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    const infoMap = new Map([
      [
        humanV1.toLowerCase(),
        {
          isHuman: true,
          version: 1
        }
      ],
      [
        humanV2.toLowerCase(),
        {
          isHuman: true,
          version: 2
        }
      ]
    ]);

    getAvatarInfoBatchMock.mockImplementation(async (avatars: string[]) => {
      return avatars.map((avatar) => {
        const lower = avatar.toLowerCase();
        const info = infoMap.get(lower);
        return {
          avatar,
          isHuman: info?.isHuman ?? false,
          version: info?.version ?? 1
        };
      });
    });

    const routerService = new FakeRouterService();
    const deps = makeDeps({circlesRpc, routerService});
    const cfg = makeConfig({
      dryRun: false,
      avatarInfoBatchSize: 10
    });

    const outcome = await runOnce(deps, cfg);

    expect(outcome.baseGroupCount).toBe(1);
    expect(outcome.humanTrustCount).toBe(1);
    expect(outcome.routerTrustCount).toBe(1);
    expect(outcome.pendingTrustCount).toBe(1);
    expect(outcome.executedTrustCount).toBe(1);
    expect(outcome.txHashes).toEqual(["0xtx_1"]);
    expect(outcome.plans).toEqual([
      {
        baseGroup: baseGroup.toLowerCase(),
        addresses: [humanV2.toLowerCase()]
      }
    ]);
    expect(routerService.calls).toEqual([
      {baseGroup: baseGroup.toLowerCase(), crcAddresses: [humanV2.toLowerCase()]}
    ]);

    expect(getAvatarInfoBatchMock).toHaveBeenCalledTimes(1);
  });

  it("enables routing even when a base group does not trust the router", async () => {
    const baseGroup = getAddress("0x1000000000000000000000000000000000000003");

    const humanAlice = getAddress("0x2000000000000000000000000000000000000004");

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.baseGroups = [baseGroup];
    circlesRpc.trusteesByTruster[baseGroup.toLowerCase()] = [humanAlice];
    circlesRpc.trusteesByTruster[ROUTER_ADDRESS.toLowerCase()] = [];

    getAvatarInfoBatchMock.mockImplementation(async (avatars: string[]) => {
      return avatars.map((avatar) => {
        const lower = avatar.toLowerCase();
        const isHuman = lower === humanAlice.toLowerCase();
        return {
          avatar,
          isHuman,
          version: isHuman ? 2 : 1
        };
      });
    });

    const routerService = new FakeRouterService();
    const logger = new FakeLogger(true);
    const deps = makeDeps({circlesRpc, routerService, logger});
    const cfg = makeConfig({dryRun: false});

    const outcome = await runOnce(deps, cfg);

    expect(outcome.baseGroupCount).toBe(1);
    expect(outcome.humanTrustCount).toBe(1);
    expect(outcome.routerTrustCount).toBe(1);
    expect(outcome.pendingTrustCount).toBe(1);
    expect(outcome.executedTrustCount).toBe(1);
    expect(outcome.txHashes).toEqual(["0xtx_1"]);
    expect(outcome.plans).toEqual([
      {
        baseGroup: baseGroup.toLowerCase(),
        addresses: [humanAlice.toLowerCase()]
      }
    ]);
    expect(routerService.calls).toEqual([
      {baseGroup: baseGroup.toLowerCase(), crcAddresses: [humanAlice.toLowerCase()]}
    ]);
    const warnMessages = logger.logs.filter((log) => log.level === "warn").map((log) => String(log.args[0]));
    expect(warnMessages.length).toBe(0);
  });
});
