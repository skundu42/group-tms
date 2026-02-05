import {getAddress} from "ethers";
import {runOnce, type Deps, type RunConfig} from "../../../src/apps/gp-crc/logic";
import {
  FakeAvatarSafeService,
  FakeAvatarSafeMappingStore,
  FakeBlacklist,
  FakeCirclesRpc,
  FakeGroupService,
  FakeLogger
} from "../../../fakes/fakes";

let registerHumanPages: string[][] = [];

// Mock the Circles SDK query layer so runOnce can page through RegisterHuman rows.
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

const RPC_URL = "https://rpc.stub";
const GROUP_ADDRESS = "0x1000000000000000000000000000000000000000";

function makeDeps(overrides?: Partial<Deps>): Deps {
  const blacklistingService = new FakeBlacklist();
  const logger = new FakeLogger(true);
  const groupService = new FakeGroupService();
  const avatarSafeService = new FakeAvatarSafeService();
  const circlesRpc = new FakeCirclesRpc();

  return {
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
    fetchPageSize: 1_000,
    groupAddress: GROUP_ADDRESS,
    dryRun: false,
    groupBatchSize: 10,
    ...overrides
  };
}

describe("gp-crc runOnce (query-based)", () => {
  beforeEach(() => {
    registerHumanPages = [];
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

  it("trusts allowed avatars with safes and skips blacklisted ones", async () => {
    const allowedInput = "0xaaaa000000000000000000000000000000000000";
    const blockedInput = "0xbbbb000000000000000000000000000000000000";
    registerHumanPages = [[allowedInput, blockedInput, allowedInput]];

    const blacklistingService = new FakeBlacklist(new Set([blockedInput]));
    const avatarSafeService = new FakeAvatarSafeService({[allowedInput]: "0xsafe1"});
    const groupService = new FakeGroupService();

    const deps = makeDeps({blacklistingService, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const allowed = getAddress(allowedInput);
    const blocked = getAddress(blockedInput);

    expect(outcome.allowedAvatars).toEqual([allowed]);
    expect(outcome.blacklistedAvatars).toEqual([blocked]);
    expect(outcome.trustedAvatars).toEqual([allowed]);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.untrustTxHashes).toEqual([]);
  });

  it("skips avatars that are already trusted in the group", async () => {
    const alreadyTrusted = "0x1111000000000000000000000000000000000000";
    const newcomer = "0x2222000000000000000000000000000000000000";
    registerHumanPages = [[alreadyTrusted, newcomer]];

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [alreadyTrusted];

    const avatarSafeService = new FakeAvatarSafeService({
      [alreadyTrusted]: "0xsafeA",
      [newcomer]: "0xsafeB"
    });
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.trustedAvatars).toEqual([getAddress(newcomer)]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0]).toEqual({
      type: "trust",
      groupAddress: cfg.groupAddress,
      trusteeAddresses: [getAddress(newcomer)]
    });
  });

  it("skips allowed avatars without configured safes", async () => {
    const withSafe = "0x1111000000000000000000000000000000000000";
    const withoutSafe = "0x2222000000000000000000000000000000000000";
    registerHumanPages = [[withSafe, withoutSafe]];

    const avatarSafeService = new FakeAvatarSafeService({
      [withSafe]: "0xsafe1111"
    });
    const groupService = new FakeGroupService();

    const deps = makeDeps({avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(outcome.trustedAvatars).toEqual([getAddress(withSafe)]);
    expect(groupService.calls).toHaveLength(1);
    expect(groupService.calls[0].trusteeAddresses).toEqual([getAddress(withSafe)]);
  });

  it("supports dry-run mode by skipping on-chain trust calls", async () => {
    const avatarInput = "0xcccc000000000000000000000000000000000000";
    registerHumanPages = [[avatarInput]];

    const groupService = new FakeGroupService();
    const deps = makeDeps({groupService});
    const cfg = makeConfig({dryRun: true});

    const outcome = await runOnce(deps, cfg);

    const avatar = getAddress(avatarInput);
    expect(outcome.trustedAvatars).toEqual([avatar]);
    expect(outcome.trustTxHashes).toEqual([]);
    expect(groupService.calls).toHaveLength(0);
  });

  it("retries trust batches on retryable errors before succeeding", async () => {
    const avatarInput = "0xdddd000000000000000000000000000000000000";
    registerHumanPages = [[avatarInput]];

    class FlakyGroupService extends FakeGroupService {
      attempts = 0;
      override async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error("temporary");
          (error as any).code = "NETWORK_ERROR";
          throw error;
        }
        return super.trustBatchWithConditions(groupAddress, trusteeAddresses);
      }
    }

    const groupService = new FlakyGroupService();
    const deps = makeDeps({groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(groupService.attempts).toBe(2);
    expect(outcome.trustTxHashes).toEqual(["0xtrust_1"]);
  });

  it("retries blacklist checks on retryable errors", async () => {
    const avatarInput = "0xffff111100000000000000000000000000000000";
    registerHumanPages = [[avatarInput]];

    class FlakyBlacklistService extends FakeBlacklist {
      attempts = 0;
      override async checkBlacklist(addresses: string[]) {
        this.attempts += 1;
        if (this.attempts === 1) {
          const error = new Error("temporary");
          (error as any).code = "NETWORK_ERROR";
          throw error;
        }
        return super.checkBlacklist(addresses);
      }
    }

    const blacklistingService = new FlakyBlacklistService();
    const deps = makeDeps({blacklistingService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    expect(blacklistingService.attempts).toBe(2);
    expect(outcome.trustedAvatars).toEqual([getAddress(avatarInput)]);
  });

  it("untrusts avatars that become blacklisted", async () => {
    const avatarInput = "0x4444000000000000000000000000000000000000";
    registerHumanPages = [[]]; // No new humans; trust list only

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    const blacklistingService = new FakeBlacklist(new Set([avatarInput]));
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, blacklistingService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const avatar = getAddress(avatarInput);
    expect(outcome.untrustedAvatars).toEqual([avatar]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
  });

  it("untrusts avatars that no longer have an associated safe", async () => {
    const avatarInput = "0x5555000000000000000000000000000000000000";
    registerHumanPages = [[]];

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarInput];

    const avatarSafeService = new FakeAvatarSafeService({}); // no safes
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const avatar = getAddress(avatarInput);
    expect(outcome.untrustedAvatars).toEqual([avatar]);
    expect(outcome.untrustTxHashes).toEqual(["0xuntrust_1"]);
  });

  it("reassigns safes and force-untrusts previous owners when conflicts are resolved via mapping store", async () => {
    const oldAvatarInput = "0x1111000000000000000000000000000000000000";
    const newAvatarInput = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";
    registerHumanPages = [[newAvatarInput]];

    const circlesRpc = new FakeCirclesRpc();
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [oldAvatarInput];

    const avatarSafeService = new FakeAvatarSafeService({
      [oldAvatarInput]: sharedSafe,
      [newAvatarInput]: sharedSafe
    });
    const mappingStore = new FakeAvatarSafeMappingStore({
      [oldAvatarInput]: sharedSafe
    });
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const oldAvatar = getAddress(oldAvatarInput);
    const newAvatar = getAddress(newAvatarInput);

    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([oldAvatar]);
    expect(outcome.untrustedAvatars).toContain(oldAvatar);
    expect(outcome.trustedAvatars).toContain(newAvatar);

    const saved = mappingStore.getSavedMapping();
    expect(saved.get(newAvatar)).toBe(sharedSafe);
    expect(saved.has(oldAvatar)).toBe(false);
  });

  it("keeps stored winner when all conflict claimants were previously seen (no loop)", async () => {
    const avatarA = "0x1111000000000000000000000000000000000000";
    const avatarB = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";
    // Both avatars are registered humans so they appear in the conflict.
    registerHumanPages = [[avatarA, avatarB]];

    const circlesRpc = new FakeCirclesRpc();
    // A is already trusted in the group (winner from a previous run).
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarA];

    const avatarSafeService = new FakeAvatarSafeService({
      [avatarA]: sharedSafe,
      [avatarB]: sharedSafe
    });

    // Stored mapping says A owns the safe.
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[avatarA]: sharedSafe},
      // Conflict history already knows about both A and B.
      {[sharedSafe]: [getAddress(avatarA), getAddress(avatarB)]}
    );
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    // No trust/untrust should happen — conflict is stable.
    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([]);
    expect(outcome.untrustedAvatars).toEqual([]);
    expect(outcome.trustedAvatars).toEqual([]);

    // Mapping should still have A as the winner.
    const saved = mappingStore.getSavedMapping();
    expect(saved.get(getAddress(avatarA))).toBe(sharedSafe);
  });

  it("switches trust only when a genuinely new claimant appears", async () => {
    const avatarA = "0x1111000000000000000000000000000000000000";
    const avatarB = "0x2222000000000000000000000000000000000000";
    const avatarC = "0x3333000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";
    registerHumanPages = [[avatarA, avatarB, avatarC]];

    const circlesRpc = new FakeCirclesRpc();
    // A is currently trusted.
    circlesRpc.trusteesByTruster[GROUP_ADDRESS.toLowerCase()] = [avatarA];

    const avatarSafeService = new FakeAvatarSafeService({
      [avatarA]: sharedSafe,
      [avatarB]: sharedSafe,
      [avatarC]: sharedSafe
    });

    // A is stored winner. History knows A and B but NOT C.
    const mappingStore = new FakeAvatarSafeMappingStore(
      {[avatarA]: sharedSafe},
      {[sharedSafe]: [getAddress(avatarA), getAddress(avatarB)]}
    );
    const groupService = new FakeGroupService();

    const deps = makeDeps({circlesRpc, avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const normalA = getAddress(avatarA);
    const normalC = getAddress(avatarC);

    // C is genuinely new → A should be untrusted, C trusted.
    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([normalA]);
    expect(outcome.untrustedAvatars).toContain(normalA);
    expect(outcome.trustedAvatars).toContain(normalC);

    // Mapping updated to C.
    const saved = mappingStore.getSavedMapping();
    expect(saved.get(normalC)).toBe(sharedSafe);
    expect(saved.has(normalA)).toBe(false);

    // History now includes all three.
    const history = mappingStore.getSavedConflictHistory();
    const safeHistory = history.get(sharedSafe)!.map((a) => a.toLowerCase());
    expect(safeHistory).toContain(normalA.toLowerCase());
    expect(safeHistory).toContain(getAddress(avatarB).toLowerCase());
    expect(safeHistory).toContain(normalC.toLowerCase());
  });

  it("initializes conflict history on first-time conflict", async () => {
    const avatarA = "0x1111000000000000000000000000000000000000";
    const avatarB = "0x2222000000000000000000000000000000000000";
    const sharedSafe = "0xSAFE000000000000000000000000000000000001";
    registerHumanPages = [[avatarA, avatarB]];

    const avatarSafeService = new FakeAvatarSafeService({
      [avatarA]: sharedSafe,
      [avatarB]: sharedSafe
    });

    // No prior mapping or history at all.
    const mappingStore = new FakeAvatarSafeMappingStore();
    const groupService = new FakeGroupService();

    const deps = makeDeps({avatarSafeService, avatarSafeMappingStore: mappingStore, groupService});
    const cfg = makeConfig();

    const outcome = await runOnce(deps, cfg);

    const normalB = getAddress(avatarB);

    // Should pick last claimant (B) as winner.
    expect(outcome.trustedAvatars).toContain(normalB);
    expect(outcome.safeReassignmentUntrustedAvatars).toEqual([]);

    // Mapping should store B.
    const saved = mappingStore.getSavedMapping();
    expect(saved.get(normalB)).toBe(sharedSafe);

    // Conflict history should now contain both A and B.
    const history = mappingStore.getSavedConflictHistory();
    const safeHistory = history.get(sharedSafe)!.map((a) => a.toLowerCase());
    expect(safeHistory).toContain(getAddress(avatarA).toLowerCase());
    expect(safeHistory).toContain(normalB.toLowerCase());
  });
});
