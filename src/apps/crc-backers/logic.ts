import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {IBlacklistingService} from "../../interfaces/IBlacklistingService";
import {IGroupService} from "../../interfaces/IGroupService";
import {IBackingInstanceService, ResetCowSwapOrderResult, CreateLBPResult} from "../../interfaces/IBackingInstanceService";
import {ISlackService} from "../../interfaces/ISlackService";
import {IChainRpc} from "../../interfaces/IChainRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {CrcV2_CirclesBackingCompleted, CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";

export type RunConfig = {
  confirmationBlocks: number;
  backingFactoryAddress: string;
  backersGroupAddress: string;
  deployedAtBlock: number;
  expectedTimeTillCompletion: number; // seconds
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  chainRpc: IChainRpc;
  blacklistingService: IBlacklistingService;
  groupService: IGroupService;
  cowSwapService: IBackingInstanceService;
  slackService: ISlackService;
  logger: ILoggerService;
};

/**
 * Finds all valid (not blacklisted) backing completed events since the last known block.
 */
async function findValidBackingEvents(
  circlesRpc: ICirclesRpc,
  blacklistingService: IBlacklistingService,
  backingFactoryAddress: string,
  lastKnownBlock: number,
  toBlock: number,
  LOG: ILoggerService
): Promise<{
  totalBackingEvents: number,
  validBackingEvents: CrcV2_CirclesBackingCompleted[],
  blacklistedAddresses: Set<string>
}> {
  const newBackingCompletedEvents = await circlesRpc.fetchBackingCompletedEvents(backingFactoryAddress, lastKnownBlock, toBlock);
  LOG.debug(`Fetched ${newBackingCompletedEvents.length} completed backing events since block ${lastKnownBlock} to block ${toBlock}.`);

  const addressesToCheck = Array.from(new Set(newBackingCompletedEvents.map(e => e.backer.toLowerCase())));
  const verdicts = await blacklistingService.checkBlacklist(addressesToCheck);
  const blacklistedAddresses = new Set(
    verdicts
      .filter(v => v.is_bot || v.category === "blocked" || v.category === "flagged")
      .map(v => v.address.toLowerCase())
  );

  return {
    totalBackingEvents: newBackingCompletedEvents.length,
    validBackingEvents: newBackingCompletedEvents.filter(o => !blacklistedAddresses.has(o.backer.toLowerCase())),
    blacklistedAddresses
  };
}

export function batchEvents(backingEvents: CrcV2_CirclesBackingCompleted[]) {
  const trustBatchSize = 50;
  const batches: CrcV2_CirclesBackingCompleted[][] = [];
  for (let i = 0; i < backingEvents.length; i += trustBatchSize) {
    batches.push(backingEvents.slice(i, i + trustBatchSize));
  }
  return batches;
}

/**
 * Trusts all new backers by checking their backing completed events against the blacklisting service
 * and adding them to the Circles Backers group. (Logs only when something happens.)
 */
export async function trustAllNewBackers(
  circlesRpc: ICirclesRpc,
  blacklistingService: IBlacklistingService,
  groupService: IGroupService,
  groupAddress: string,
  backingFactoryAddress: string,
  lastKnownBlock: number,
  currentHead: number,
  LOG: ILoggerService
): Promise<{
  totalBackingEvents: number,
  validBackingEvents: CrcV2_CirclesBackingCompleted[],
  blacklistedAddresses: Set<string>,
  newBackingEvents: CrcV2_CirclesBackingCompleted[]
}> {
  const backingEvents = await findValidBackingEvents(circlesRpc, blacklistingService, backingFactoryAddress, lastKnownBlock, currentHead, LOG);

  const haveAnyCompletedEvents = backingEvents.totalBackingEvents > 0;
  if (haveAnyCompletedEvents) {
    LOG.info(`Found ${backingEvents.totalBackingEvents} completed backing events since block ${lastKnownBlock} to block ${currentHead}.`);
    LOG.info(`  - Valid (non-blacklisted): ${backingEvents.validBackingEvents.length}`);
    const haveBlacklisted = backingEvents.blacklistedAddresses.size > 0;
    if (haveBlacklisted) {
      LOG.info(`  - Blacklisted addresses present (hidden; enable verbose to see list).`);
      LOG.table(Array.from(backingEvents.blacklistedAddresses).map((address) => ({address})));
    }
  }

  const trustees = new Set((await circlesRpc.fetchAllTrustees(groupAddress)).map((x) => x.toLowerCase()));
  const notAlreadyTrusted = backingEvents.validBackingEvents.filter((e) => !trustees.has(e.backer.toLowerCase()));

  const willAddAny = notAlreadyTrusted.length > 0;
  if (haveAnyCompletedEvents) {
    LOG.info(`  - Already trusted: ${trustees.size}. To add now: ${notAlreadyTrusted.length}.`);
  }

  if (willAddAny) {
    LOG.info(`  - New backers to trust (${notAlreadyTrusted.length}):`);
    for (const e of notAlreadyTrusted) {
      LOG.info(`    - backer=${e.backer}, instance=${e.circlesBackingInstance}`);
    }

    LOG.debug(`Detailed list of new backers to trust (verbose):`);
    LOG.table(
      notAlreadyTrusted.map((e) => ({
        backer: e.backer,
        instance: e.circlesBackingInstance,
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
        timestamp: e.timestamp
      })),
      ["backer", "instance", "blockNumber", "transactionHash", "timestamp"]
    );

    const batches = batchEvents(notAlreadyTrusted);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const backersToTrust = batch.map((e) => e.backer);

      LOG.debug(`  - Batch ${i + 1}/${batches.length} addresses:`, backersToTrust);
      LOG.info(`  - Trusting batch ${i + 1}/${batches.length} (${batch.length} backers)...`);

      // NOTE: call kept here to reflect real behavior. Your current main.ts had it commented.
      await groupService.trustBatchWithConditions(groupAddress, backersToTrust);

      LOG.info(`  - Batch ${i + 1}/${batches.length} succeeded.`);
    }

    LOG.info(`[${lastKnownBlock}->${currentHead}] Trusted ${notAlreadyTrusted.length} new backers in ${batchEvents(notAlreadyTrusted).length} batches.`);
  }

  return {
    ...backingEvents,
    newBackingEvents: notAlreadyTrusted
  };
}

/**
 * Finds all pending backing processes that have been initiated but not yet completed since the last known block.
 */
export async function findPendingBackingProcesses(
  circlesRpc: ICirclesRpc,
  backingFactoryAddress: string,
  lastKnownBlock: number,
  currentHead: number,
  completedBackingProcesses: {
    totalBackingEvents: number;
    validBackingEvents: CrcV2_CirclesBackingCompleted[];
    blacklistedAddresses: Set<string>;
    newBackingEvents: CrcV2_CirclesBackingCompleted[];
  },
  LOG: ILoggerService
) {
  const key = (event: CrcV2_CirclesBackingInitiated | CrcV2_CirclesBackingCompleted) =>
    `${event.backer.toLowerCase()}-${event.circlesBackingInstance.toLowerCase()}`;

  const initiatedBackingProcesses = await circlesRpc.fetchBackingInitiatedEvents(backingFactoryAddress, lastKnownBlock, currentHead);
  LOG.debug(`Fetched ${initiatedBackingProcesses.length} initiated backing processes.`);

  const completedKeys = new Set(completedBackingProcesses.validBackingEvents.map(key));
  const notBlacklisted = initiatedBackingProcesses.filter(
    (e) => !completedBackingProcesses.blacklistedAddresses.has(e.backer.toLowerCase())
  );

  const pending = notBlacklisted.filter((event) => !completedKeys.has(key(event)));
  LOG.debug(`After filtering, pending initiated-but-not-completed: ${pending.length}`);
  return pending;
}

/**
 * Computes the exact deadline of a CirclesBacking instance.
 */
export function computeOrderDeadlineSeconds(initiated: CrcV2_CirclesBackingInitiated): number {
  const hasTimestamp = typeof initiated.timestamp === "number" && initiated.timestamp > 0;
  if (!hasTimestamp) {
    throw new Error(`Initiated event at block ${initiated.blockNumber} has no timestamp.`);
  }
  const oneDaySeconds = 24 * 60 * 60;
  return initiated.timestamp! + oneDaySeconds;
}

/**
 * One-shot run; pure-logic orchestration that we can test with mocks.
 */
export async function runOnce(deps: Deps, cfg: RunConfig): Promise<void> {
  const {
    circlesRpc, chainRpc, blacklistingService, groupService,
    cowSwapService, slackService, logger: LOG
  } = deps;

  // 0. Head with a small reorg buffer
  const currentHead = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, currentHead.blockNumber - cfg.confirmationBlocks /* confirmations */);
  LOG.debug(`Head=${currentHead.blockNumber}, safeHead=${safeHeadBlock}, headTs=${currentHead.timestamp}`);

  // 1. Start from contract deployment
  const lastKnownBlock = cfg.deployedAtBlock;

  // 2–3–4. Trust all newly completed backers (skipping blacklisted & already trusted).
  const completedBackingProcesses = await trustAllNewBackers(
    circlesRpc,
    blacklistingService,
    groupService,
    cfg.backersGroupAddress,
    cfg.backingFactoryAddress,
    lastKnownBlock,
    safeHeadBlock,
    LOG
  );

  // 5. Initiated-but-not-completed
  const pendingBackingProcesses = await findPendingBackingProcesses(
    circlesRpc,
    cfg.backingFactoryAddress,
    lastKnownBlock,
    safeHeadBlock,
    completedBackingProcesses,
    LOG
  );

  const havePending = pendingBackingProcesses.length > 0;
  if (havePending) {
    LOG.info(`Found ${pendingBackingProcesses.length} pending backing processes since block ${lastKnownBlock} to block ${safeHeadBlock}`);
    LOG.table(pendingBackingProcesses, ["blockNumber", "transactionHash", "backer", "circlesBackingInstance"]);
  }

  // 6. Reconcile overdue pending processes.
  const pendingProcessesToReconcile = pendingBackingProcesses.filter(event => {
    if (!event.timestamp) {
      throw new Error(`Event ${event.$event} at block ${event.blockNumber} has no timestamp.`);
    }
    return currentHead.timestamp - event.timestamp > cfg.expectedTimeTillCompletion;
  });

  const haveOverdue = pendingProcessesToReconcile.length > 0;
  if (haveOverdue) {
    LOG.info(`Found ${pendingProcessesToReconcile.length} pending processes older than ${cfg.expectedTimeTillCompletion}s.`);
    LOG.table(pendingProcessesToReconcile, ["blockNumber", "transactionHash", "backer", "circlesBackingInstance"]);
  }

  for (const event of pendingProcessesToReconcile) {
    if (!event.timestamp) {
      throw new Error(`Event ${event.$event} at block ${event.blockNumber} has no timestamp.`);
    }

    const deadline = computeOrderDeadlineSeconds(event);
    const pastDeadline = currentHead.timestamp >= deadline;

    if (pastDeadline) {
      const lbpState: CreateLBPResult = await cowSwapService.simulateCreateLbp(event.circlesBackingInstance);
      switch (lbpState) {
        case "Success": {
          LOG.info(`Creating LBP for ${event.backer} at ${event.circlesBackingInstance}...`);
          const txHash = await cowSwapService.createLbp(event.circlesBackingInstance);
          LOG.info(`Creating LBP for ${event.backer} at ${event.circlesBackingInstance} succeeded: ${txHash}`);
          continue;
        }
        case "LBPAlreadyCreated": {
          continue;
        }
        case "OrderNotYetFilled": {
          const reason = `OrderNotYetFilled for ${event.circlesBackingInstance} after our deadline calc; will re-check later.`;
          LOG.info(reason);
          await slackService.notifyBackingNotCompleted(event, reason);
          break; // fall through to reset below
        }
        case "BackingAssetBalanceInsufficient": {
          const reason = "BackingAssetBalanceInsufficient - backing asset balance insufficient after filled order";
          LOG.info(`LBP create reported balance shortfall for ${event.circlesBackingInstance}; notifying Slack.`);
          await slackService.notifyBackingNotCompleted(event, reason);
          continue;
        }
        default:
          throw new Error(`Unknown LBP state ${lbpState}`);
      }
    }

    // Before-deadline path
    const orderState: ResetCowSwapOrderResult = await cowSwapService.simulateResetCowSwapOrder(event.circlesBackingInstance);
    switch (orderState) {
      case "OrderValid": {
        LOG.info(`Resetting order for ${event.backer} at ${event.circlesBackingInstance}...`);
        const txHash = await cowSwapService.resetCowSwapOrder(event.circlesBackingInstance);
        LOG.info(`Resetting order for ${event.backer} at ${event.circlesBackingInstance} succeeded: ${txHash}`);
        break;
      }
      case "OrderAlreadySettled": {
        const lbpState = await cowSwapService.simulateCreateLbp(event.circlesBackingInstance);
        if (lbpState === "Success") {
          LOG.info(`LBP posthook likely missed; creating LBP for ${event.circlesBackingInstance}...`);
          const txHash = await cowSwapService.createLbp(event.circlesBackingInstance);
          LOG.info(`LBP created for ${event.circlesBackingInstance}: ${txHash}`);
          continue;
        }
        if (lbpState === "LBPAlreadyCreated") {
          continue;
        }
        if (lbpState === "BackingAssetBalanceInsufficient") {
          const text = `BackingAssetBalanceInsufficient after filled order for ${event.circlesBackingInstance}`;
          LOG.warn(text);
          await slackService.notifyBackingNotCompleted(event, text);
          continue;
        }
        if (lbpState === "OrderNotYetFilled") {
          const text = `OrderNotYetFilled inconsistency (settled vs not-filled) for ${event.circlesBackingInstance}; will re-check later.`;
          LOG.warn(text);
          await slackService.notifyBackingNotCompleted(event, text);
          continue;
        }
        throw new Error(`Unknown LBP state ${lbpState}`);
      }
      case "OrderUidIsTheSame": {
        break;
      }
      default:
        throw new Error(`Unknown order state ${orderState}`);
    }
  }
}
