import {
  runOnce,
  computeOrderDeadlineSeconds,
  findPendingBackingProcesses,
  trustAllNewBackers,
  batchEvents,
  type Deps,
  type RunConfig
} from "../../../src/apps/crc-backers/logic";

import {
  FakeBackingInstanceService,
  FakeBlacklist,
  FakeChainRpc,
  FakeCirclesRpc,
  FakeGroupService,
  FakeLogger,
  FakeSlack
} from "../../../fakes/fakes";
import {Address} from "@circles-sdk/utils";
import {mkCompleted, mkInitiated} from "../../../fakes/factories";

const GROUP = "0xgroup000000000000000000000000000000000000";
const DEPLOYED_AT = 39_743_285;
const BACKING_FACTORY_ADDRESS = "0xbackingFactory0000000000000000000000000000";
const HEAD = {blockNumber: DEPLOYED_AT + 1_000, timestamp: 200_000};
const SAFE_HEAD = HEAD.blockNumber - 6;
const CFG: RunConfig = {
  confirmationBlocks: 2,
  backingFactoryAddress: BACKING_FACTORY_ADDRESS,
  backersGroupAddress: GROUP,
  deployedAtBlock: DEPLOYED_AT,
  expectedTimeTillCompletion: 60
};

function makeDeps(overrides?: Partial<Deps>): Deps {
  const circlesRpc = new FakeCirclesRpc();
  const chainRpc = new FakeChainRpc(HEAD);
  const blacklistingService = new FakeBlacklist();
  const groupService = new FakeGroupService();
  const cowSwapService = new FakeBackingInstanceService();
  const slackService = new FakeSlack();
  const logger = new FakeLogger(true);

  return {
    circlesRpc,
    chainRpc,
    blacklistingService,
    groupService,
    cowSwapService,
    slackService,
    logger,
    ...overrides
  };
}

describe("batchEvents", () => {
  it("batches by 50", () => {
    const events = Array.from({length: 120}, (_, i) =>
      mkCompleted({backer: `0x${(i + 1).toString(16).padStart(40, "a")}`})
    );
    const batches = batchEvents(events);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(50);
    expect(batches[1].length).toBe(50);
    expect(batches[2].length).toBe(20);
  });
});

describe("trustAllNewBackers", () => {
  it("trusts new, non-blacklisted backers and logs counts", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;

    const a = mkCompleted({backer: "0xA".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 1});
    const b = mkCompleted({backer: "0xB".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 2});
    rpc.completed = [a, b];
    (rpc as FakeCirclesRpc).trusteesByTruster[GROUP.toLowerCase()] = [];

    const res = await trustAllNewBackers(
      deps.circlesRpc,
      deps.blacklistingService,
      deps.groupService,
      GROUP,
      BACKING_FACTORY_ADDRESS,
      DEPLOYED_AT,
      SAFE_HEAD,
      deps.logger
    );

    const grp = deps.groupService as FakeGroupService;
    expect(res.totalBackingEvents).toBe(2);
    expect(res.validBackingEvents.length).toBe(2);
    expect(grp.calls.length).toBe(1);
    expect(grp.calls[0].trusteeAddresses).toEqual([a.backer, b.backer]);
  });

  it("filters already-trusted and blacklisted", async () => {
    const blocked = new Set<string>(["0xa".padEnd(42, "0")]);
    const deps = makeDeps({blacklistingService: new FakeBlacklist(blocked)});
    const rpc = deps.circlesRpc as FakeCirclesRpc;

    const a = mkCompleted({backer: "0xA".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 1});
    const b = mkCompleted({backer: "0xB".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 2});
    rpc.completed = [a, b];
    (rpc as FakeCirclesRpc).trusteesByTruster[GROUP.toLowerCase()] = [b.backer];

    const res = await trustAllNewBackers(
      deps.circlesRpc,
      deps.blacklistingService,
      deps.groupService,
      GROUP,
      BACKING_FACTORY_ADDRESS,
      DEPLOYED_AT,
      SAFE_HEAD,
      deps.logger
    );

    const grp = deps.groupService as FakeGroupService;
    expect(res.totalBackingEvents).toBe(2);
    expect(res.validBackingEvents.map((x:any) => x.backer)).toEqual([b.backer]);
    expect(res.newBackingEvents.length).toBe(0);
    expect(grp.calls.length).toBe(0);
  });

  it("batches 120 backers into 3 calls of 50/50/20", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    rpc.completed = Array.from({length: 120}, (_, i) =>
      mkCompleted({
        backer: `0x${(i + 1).toString(16).padStart(40, "b")}`,
        blockNumber: DEPLOYED_AT + 1 + i
      })
    );

    const res = await trustAllNewBackers(
      deps.circlesRpc,
      deps.blacklistingService,
      deps.groupService,
      GROUP,
      BACKING_FACTORY_ADDRESS,
      DEPLOYED_AT,
      SAFE_HEAD,
      deps.logger
    );
    const grp = deps.groupService as FakeGroupService;
    expect(res.validBackingEvents.length).toBe(120);
    expect(grp.calls.length).toBe(3);
    expect(grp.calls[0].trusteeAddresses.length).toBe(50);
    expect(grp.calls[1].trusteeAddresses.length).toBe(50);
    expect(grp.calls[2].trusteeAddresses.length).toBe(20);
  });

  it("filters both 'blocked' and 'flagged' addresses (neither gets added)", async () => {
    // Arrange: blacklist one as blocked, one as flagged
    const blocked = new Set<string>(["0xbad".padEnd(42, "0")]);
    const flagged = new Set<string>(["0xwarn".padEnd(42, "0")]);
    const deps = makeDeps({blacklistingService: new FakeBlacklist(blocked, flagged)});
    const rpc = deps.circlesRpc as FakeCirclesRpc;

    // Completed events: BAD (blocked), WARN (flagged), and OK (clean)
    const badEvt = mkCompleted({backer: "0xBAD".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 1});
    const warnEvt = mkCompleted({backer: "0xWARN".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 2});
    const okEvt = mkCompleted({backer: "0xOK".padEnd(42, "0") as Address, blockNumber: DEPLOYED_AT + 3});
    rpc.completed = [badEvt, warnEvt, okEvt];

    // No one is already trusted from state
    (rpc as FakeCirclesRpc).trusteesByTruster[GROUP.toLowerCase()] = [];

    // Act
    const res = await trustAllNewBackers(
      deps.circlesRpc,
      deps.blacklistingService,
      deps.groupService,
      GROUP,
      BACKING_FACTORY_ADDRESS,
      DEPLOYED_AT,
      SAFE_HEAD,
      deps.logger
    );

    // Assert: only OK goes through; BAD and WARN are excluded
    const grp = deps.groupService as FakeGroupService;

    expect(res.totalBackingEvents).toBe(3);
    expect(Array.from(res.blacklistedAddresses)).toEqual(
      expect.arrayContaining([badEvt.backer.toLowerCase(), warnEvt.backer.toLowerCase()])
    );
    expect(res.validBackingEvents.map((e:any) => e.backer.toLowerCase())).toEqual([okEvt.backer.toLowerCase()]);

    expect(grp.calls).toHaveLength(1);
    expect(grp.calls[0].trusteeAddresses.map(x => x.toLowerCase())).toEqual([okEvt.backer.toLowerCase()]);
  });
});

describe("findPendingBackingProcesses", () => {
  it("calls fetchBackingInitiatedEvents and filters out completed + blacklisted", async () => {
    const blocked = new Set<string>(["0xdead".padEnd(42, "0")]);
    const deps = makeDeps({blacklistingService: new FakeBlacklist(blocked)});
    const rpc = deps.circlesRpc as FakeCirclesRpc;

    const completed = mkCompleted({
      backer: "0xdone".padEnd(42, "0") as Address,
      circlesBackingInstance: "0xinst1".padEnd(42, "1") as Address,
      blockNumber: DEPLOYED_AT + 5
    });

    const init1 = mkInitiated({
      backer: completed.backer,
      circlesBackingInstance: completed.circlesBackingInstance,
      blockNumber: DEPLOYED_AT + 2,
      timestamp: 9_500
    });
    const init2 = mkInitiated({
      backer: "0xok".padEnd(42, "0") as Address,
      circlesBackingInstance: "0xinst2".padEnd(42, "1") as Address,
      blockNumber: DEPLOYED_AT + 3,
      timestamp: 9_600
    });
    const init3 = mkInitiated({
      backer: "0xdead".padEnd(42, "0") as Address,
      circlesBackingInstance: "0xinst3".padEnd(42, "1") as Address,
      blockNumber: DEPLOYED_AT + 4,
      timestamp: 9_700
    });

    rpc.completed = [completed];
    rpc.initiated = [init1, init2, init3];

    const completedSet = {
      totalBackingEvents: 1,
      validBackingEvents: [completed],
      blacklistedAddresses: blocked,
      newBackingEvents: []
    };

    const pending = await findPendingBackingProcesses(
      deps.circlesRpc,
      BACKING_FACTORY_ADDRESS,
      DEPLOYED_AT,
      SAFE_HEAD,
      completedSet,
      deps.logger
    );

    expect(pending.map((p:any) => p.circlesBackingInstance.toLowerCase())).toEqual([
      init2.circlesBackingInstance.toLowerCase()
    ]);
  });
});

describe("computeOrderDeadlineSeconds", () => {
  it("throws if timestamp missing", () => {
    const bad = mkInitiated({timestamp: undefined});
    expect(() => computeOrderDeadlineSeconds(bad)).toThrow(/has no timestamp/);
  });
});

describe("runOnce – reconciliation flow", () => {
  it("before deadline (overdue wrt policy): OrderValid → resetCowSwapOrder", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    // overdue by >60s but still < 24h to hit the before-deadline branch
    const initiated = mkInitiated({
      backer: "0xok".padEnd(42, "0") as Address,
      circlesBackingInstance: "0xinst100".padEnd(42, "1") as Address,
      blockNumber: DEPLOYED_AT + 10,
      timestamp: HEAD.timestamp - 120
    });

    rpc.initiated = [initiated];
    rpc.completed = [];

    svc.simulateReset[initiated.circlesBackingInstance.toLowerCase()] = "OrderValid";
    svc.simulateCreate[initiated.circlesBackingInstance.toLowerCase()] = "Success";

    await runOnce(deps, CFG);

    expect(svc.resetCalls).toEqual([initiated.circlesBackingInstance.toLowerCase()]);
    expect(svc.createCalls).toEqual([]);
  });

  it("past on-chain deadline: simulateCreate Success → createLbp", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    const inst = "0xinst200".padEnd(42, "1");
    // older than 24h to hit the past-deadline branch
    rpc.initiated = [
      mkInitiated({
        backer: "0xok".padEnd(42, "0") as Address,
        circlesBackingInstance: inst as Address,
        blockNumber: DEPLOYED_AT + 11,
        timestamp: HEAD.timestamp - 100_000
      })
    ];

    svc.simulateCreate[inst.toLowerCase()] = "Success";

    await runOnce(deps, CFG);

    expect(svc.createCalls).toEqual([inst.toLowerCase()]);
    expect(svc.resetCalls).toEqual([]);
  });

  it("past on-chain deadline: simulateCreate LBPAlreadyCreated → no-op", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    const inst = "0xinst201".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({
        backer: "0xok".padEnd(42, "0") as Address,
        circlesBackingInstance: inst as Address,
        timestamp: HEAD.timestamp - 100_000
      })
    ];
    svc.simulateCreate[inst.toLowerCase()] = "LBPAlreadyCreated";

    await runOnce(deps, CFG);
    expect(svc.createCalls).toEqual([]);
    expect(svc.resetCalls).toEqual([]);
  });

  it("before deadline: OrderAlreadySettled then LBPAlreadyCreated → no-op", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    const inst = "0xinst301".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({circlesBackingInstance: inst as Address, timestamp: HEAD.timestamp - 120})
    ];
    svc.simulateReset[inst.toLowerCase()] = "OrderAlreadySettled";
    svc.simulateCreate[inst.toLowerCase()] = "LBPAlreadyCreated";

    await runOnce(deps, CFG);
    expect(svc.createCalls).toEqual([]);
  });

  it("before deadline: OrderUidIsTheSame → no-op", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    const inst = "0xinst304".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({circlesBackingInstance: inst as Address, timestamp: HEAD.timestamp - 120})
    ];
    svc.simulateReset[inst.toLowerCase()] = "OrderUidIsTheSame";
    svc.simulateCreate[inst.toLowerCase()] = "Success";

    await runOnce(deps, CFG);
    expect(svc.resetCalls.length).toBe(0);
    expect(svc.createCalls.length).toBe(0);
  });

  it("throws if an initiated event lacks timestamp during overdue filtering", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;

    // must be within the fromBlock..toBlock window
    rpc.initiated = [mkInitiated({blockNumber: DEPLOYED_AT + 10, timestamp: undefined})];

    await expect(runOnce(deps, CFG)).rejects.toThrow(/has no timestamp/);
  });

  it("past on-chain deadline: simulateCreate OrderNotYetFilled → Slack notify, then fallthrough pre-deadline path", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;
    const slack = deps.slackService as FakeSlack;

    const inst = "0xinst202".padEnd(42, "1");

    const evt = mkInitiated({
      backer: "0xok".padEnd(42, "0") as Address,
      circlesBackingInstance: inst as Address,
      timestamp: HEAD.timestamp - 100_000,
      blockNumber: DEPLOYED_AT + 12
    });
    rpc.initiated = [evt];

    // Past-deadline classification
    svc.simulateCreate[inst.toLowerCase()] = "OrderNotYetFilled";

    // We fall through to the reset path after notifying Slack, so this must be preset too.
    // Use "OrderUidIsTheSame" to avoid triggering an actual reset tx in this test.
    svc.simulateReset[inst.toLowerCase()] = "OrderUidIsTheSame";

    await runOnce(deps, CFG);

    expect(slack.notifications.length).toBe(1);
    expect(slack.notifications[0].event.circlesBackingInstance.toLowerCase()).toBe(inst.toLowerCase());
    expect(slack.notifications[0].reason).toMatch(/OrderNotYetFilled/);
  });

  it("past on-chain deadline: simulateCreate BackingAssetBalanceInsufficient → Slack notify", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;
    const slack = deps.slackService as FakeSlack;

    const inst = "0xinst203".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({
        backer: "0xok".padEnd(42, "0") as Address,
        circlesBackingInstance: inst as Address,
        timestamp: HEAD.timestamp - 100_000,
        blockNumber: DEPLOYED_AT + 13
      })
    ];
    svc.simulateCreate[inst.toLowerCase()] = "BackingAssetBalanceInsufficient";

    await runOnce(deps, CFG);
    expect(slack.notifications.length).toBe(1);
    expect(slack.notifications[0].reason).toMatch(/BackingAssetBalanceInsufficient/);
  });

  it("before deadline: OrderAlreadySettled then LBP Success → createLbp", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    const inst = "0xinst300".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({
        circlesBackingInstance: inst as Address,
        timestamp: HEAD.timestamp - 120,
        blockNumber: DEPLOYED_AT + 14
      })
    ];
    svc.simulateReset[inst.toLowerCase()] = "OrderAlreadySettled";
    svc.simulateCreate[inst.toLowerCase()] = "Success";

    await runOnce(deps, CFG);
    expect(svc.createCalls).toEqual([inst.toLowerCase()]);
  });

  it("before deadline: OrderAlreadySettled then LBPAlreadyCreated → no-op", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;

    const inst = "0xinst301".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({
        circlesBackingInstance: inst as Address,
        timestamp: HEAD.timestamp - 120,
        blockNumber: DEPLOYED_AT + 15
      })
    ];
    svc.simulateReset[inst.toLowerCase()] = "OrderAlreadySettled";
    svc.simulateCreate[inst.toLowerCase()] = "LBPAlreadyCreated";

    await runOnce(deps, CFG);
    expect(svc.createCalls).toEqual([]);
  });

  it("before deadline: OrderAlreadySettled then BackingAssetBalanceInsufficient → Slack notify", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;
    const slack = deps.slackService as FakeSlack;

    const inst = "0xinst302".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({
        circlesBackingInstance: inst as Address,
        timestamp: HEAD.timestamp - 120,
        blockNumber: DEPLOYED_AT + 16
      })
    ];
    svc.simulateReset[inst.toLowerCase()] = "OrderAlreadySettled";
    svc.simulateCreate[inst.toLowerCase()] = "BackingAssetBalanceInsufficient";

    await runOnce(deps, CFG);
    expect(slack.notifications.length).toBe(1);
    expect(slack.notifications[0].reason).toMatch(/BackingAssetBalanceInsufficient/);
  });

  it("before deadline: OrderAlreadySettled then OrderNotYetFilled → Slack notify", async () => {
    const deps = makeDeps();
    const rpc = deps.circlesRpc as FakeCirclesRpc;
    const svc = deps.cowSwapService as FakeBackingInstanceService;
    const slack = deps.slackService as FakeSlack;

    const inst = "0xinst303".padEnd(42, "1");
    rpc.initiated = [
      mkInitiated({
        circlesBackingInstance: inst as Address,
        timestamp: HEAD.timestamp - 120,
        blockNumber: DEPLOYED_AT + 17
      })
    ];
    svc.simulateReset[inst.toLowerCase()] = "OrderAlreadySettled";
    svc.simulateCreate[inst.toLowerCase()] = "OrderNotYetFilled";

    await runOnce(deps, CFG);
    expect(slack.notifications.length).toBe(1);
    expect(slack.notifications[0].reason).toMatch(/OrderNotYetFilled inconsistency/);
  });
});

