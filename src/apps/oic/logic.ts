import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {IChainRpc} from "../../interfaces/IChainRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IGroupService} from "../../interfaces/IGroupService";
import {IAffiliateGroupEventsService, AffiliateGroupChanged} from "../../interfaces/IAffiliateGroupEventsService";

export type RunConfig = {
  confirmationBlocks: number;
  groupAddress: string;
  metaOrgAddress: string;
  affiliateRegistryAddress: string;
  outputBatchSize: number;
  deployedAtBlock: number;
  dryRun?: boolean;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  chainRpc: IChainRpc;
  groupService: IGroupService;
  affiliateRegistry: IAffiliateGroupEventsService;
  logger: ILoggerService;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Helper function to fetch trustees for an address
async function fetchTrustees(
  circlesRpc: ICirclesRpc,
  address: string,
): Promise<Set<string>> {
  const trustees = await circlesRpc.fetchAllTrustees(address);
  return new Set(trustees.map(addr => addr.toLowerCase()));
}

// Helper function to calculate desired trustees efficiently
// Returns both the desired set and the union of addresses trusted by any MetaOrg trustee
async function calculateDesiredTrustees(
  circlesRpc: ICirclesRpc,
  metaOrgTrustees: Set<string>,
  affiliates: Set<string>,
): Promise<{ desired: Set<string>; trustedByAnyMetaOrgTrustee: Set<string> }> {
  // Fetch trustees for all MetaOrg trustees in parallel
  const trusteePromises = Array.from(metaOrgTrustees).map(trustee =>
    fetchTrustees(circlesRpc, trustee)
  );
  
  const secondDegreeTrusteeSets = await Promise.all(trusteePromises);
  
  // Union all second-degree trustees efficiently
  const trustedByAnyMetaOrgTrustee = new Set<string>();
  for (const trusteeSet of secondDegreeTrusteeSets) {
    for (const addr of trusteeSet) {
      trustedByAnyMetaOrgTrustee.add(addr);
    }
  }
  
  // Intersection with affiliates
  const desired = new Set<string>();
  for (const addr of trustedByAnyMetaOrgTrustee) {
    if (affiliates.has(addr)) {
      desired.add(addr);
    }
  }
  
  return { desired, trustedByAnyMetaOrgTrustee };
}

// Helper function to process trust/untrust operations sequentially to avoid nonce issues
async function processTrustOperations(
  groupService: IGroupService,
  group: string,
  shouldTrust: string[],
  shouldUntrust: string[],
  outputBatchSize: number,
  logger: ILoggerService
): Promise<void> {
  const trustBatches = chunk(shouldTrust, outputBatchSize);
  const untrustBatches = chunk(shouldUntrust, outputBatchSize);

  // Process untrust operations first, sequentially
  for (let i = 0; i < untrustBatches.length; i++) {
    const batch = untrustBatches[i];
    logger.info(`Untrusting batch ${i + 1}/${untrustBatches.length} (${batch.length})...`);
    await groupService.untrustBatch(group, batch);
    logger.info(`  - Untrust batch ${i + 1}/${untrustBatches.length} done.`);
  }

  // Then process trust operations, sequentially
  for (let i = 0; i < trustBatches.length; i++) {
    const batch = trustBatches[i];
    logger.info(`Trusting batch ${i + 1}/${trustBatches.length} (${batch.length})...`);
    await groupService.trustBatchWithConditions(group, batch);
    logger.info(`  - Trust batch ${i + 1}/${trustBatches.length} done.`);
  }
}

// Core logic shared between runOnce and runIncremental
async function executeCoreLogic(
  deps: Deps,
  cfg: RunConfig,
  affiliates: Set<string>,
): Promise<void> {
  const { circlesRpc, groupService, logger: LOG } = deps;
  
  const group = cfg.groupAddress.toLowerCase();
  const metaOrg = cfg.metaOrgAddress.toLowerCase();

  // Current trustees snapshots
  const [metaOrgTrusteesArr, groupTrusteesArr] = await Promise.all([
    circlesRpc.fetchAllTrustees(metaOrg),
    circlesRpc.fetchAllTrustees(group),
  ]);
  const metaOrgTrustees = new Set(metaOrgTrusteesArr.map((x) => x.toLowerCase()));
  const groupTrustees = new Set(groupTrusteesArr.map((x) => x.toLowerCase()));

  // Calculate desired trustees efficiently
  const { desired, trustedByAnyMetaOrgTrustee } = await calculateDesiredTrustees(
    circlesRpc,
    metaOrgTrustees,
    affiliates,
  );

  // Summary stats requested for each run
  LOG.info(
    `Run stats: trustedByMetaOrgTrustees=${trustedByAnyMetaOrgTrustee.size} currentAffiliates=${affiliates.size}`
  );

  // Calculate changes needed efficiently using set operations
  const shouldTrust = Array.from(desired).filter(h => !groupTrustees.has(h));
  const shouldUntrust = Array.from(groupTrustees).filter(h => !desired.has(h));

  LOG.info(`Decision summary:`);
  LOG.info(`  - To trust now: ${shouldTrust.length}`);
  LOG.info(`  - To untrust now: ${shouldUntrust.length}`);

  if (cfg.dryRun) {
    const detailFor = (h: string, decision: "trust" | "untrust") => ({
      address: h,
      trustedByMetaOrgTrustee: trustedByAnyMetaOrgTrustee.has(h),
      decision,
    });
    const fmt = (d: ReturnType<typeof detailFor>) =>
      `address=${d.address} trustedByMetaOrgTrustee=${d.trustedByMetaOrgTrustee} decision=${d.decision}`;
    if (shouldTrust.length) {
      for (const h of shouldTrust) {
        const d = detailFor(h, "trust");
        LOG.info(`DRY RUN trust: ${fmt(d)}`);
      }
    }
    if (shouldUntrust.length) {
      for (const h of shouldUntrust) {
        const d = detailFor(h, "untrust");
        LOG.info(`DRY RUN untrust: ${fmt(d)}`);
      }
    }
    return;
  }

  await processTrustOperations(
    groupService,
    group,
    shouldTrust,
    shouldUntrust,
    cfg.outputBatchSize,
    LOG
  );
}

export type IncrementalState = {
  initialized: boolean;
  lastSafeHeadScanned: number; 
  affiliates: Set<string>;
};

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<void> {
  const { chainRpc, affiliateRegistry, logger: LOG } = deps;

  const currentHead = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, currentHead.blockNumber - cfg.confirmationBlocks);

  const group = cfg.groupAddress.toLowerCase();
  const registry = cfg.affiliateRegistryAddress.toLowerCase();

  const startBlock = Math.max(0, cfg.deployedAtBlock);
  const affiliates = new Set<string>();

  LOG.info(`Scan range: ${startBlock} -> ${safeHeadBlock}`);
  let affEvents: AffiliateGroupChanged[] = [];
  if (startBlock <= safeHeadBlock) {
    affEvents = await affiliateRegistry.fetchAffiliateGroupChanged(registry, group, startBlock, safeHeadBlock);
  }
  // Log affiliate group change events affecting the group
  if (affEvents.length > 0) {
    const added = affEvents.filter(e => e.newGroup.toLowerCase() === group).length;
    const removed = affEvents.filter(e => e.oldGroup.toLowerCase() === group).length;
    LOG.info(
      `AffiliateGroupChanged affecting group: total=${affEvents.length} added=${added} removed=${removed}`
    );
  } else {
    LOG.info(`AffiliateGroupChanged affecting group: total=0 added=0 removed=0`);
  }

  // Apply events to maintain current affiliate set for this group
  processAffiliateEvents(affEvents, group, affiliates, false);

  // Execute the core logic
  await executeCoreLogic(deps, cfg, affiliates);
}

export async function runIncremental(
  deps: Deps,
  cfg: RunConfig,
  state: IncrementalState,
): Promise<void> {
  const { chainRpc, affiliateRegistry, logger: LOG } = deps;

  const currentHead = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, currentHead.blockNumber - cfg.confirmationBlocks);

  const group = cfg.groupAddress.toLowerCase();
  const registry = cfg.affiliateRegistryAddress.toLowerCase();

  const fromBlock = state.initialized
    ? state.lastSafeHeadScanned + 1
    : Math.max(0, cfg.deployedAtBlock);

  let affEvents: AffiliateGroupChanged[] = [];
  if (fromBlock <= safeHeadBlock) {
    LOG.info(`Scan range: ${fromBlock} -> ${safeHeadBlock}`);
    affEvents = await affiliateRegistry.fetchAffiliateGroupChanged(registry, group, fromBlock, safeHeadBlock);
    // Log affiliate group change events affecting the group
    if (affEvents.length > 0) {
      const added = affEvents.filter(e => e.newGroup.toLowerCase() === group).length;
      const removed = affEvents.filter(e => e.oldGroup.toLowerCase() === group).length;
      LOG.info(
        `AffiliateGroupChanged affecting group: total=${affEvents.length} added=${added} removed=${removed}`
      );
    } else {
      LOG.info(`AffiliateGroupChanged affecting group: total=0 added=0 removed=0`);
    }

    // Apply events to maintain current affiliate set for this group
    processAffiliateEvents(affEvents, group, state.affiliates, state.initialized);

    state.lastSafeHeadScanned = safeHeadBlock;
    state.initialized = true;
  }

  // Execute the core logic
  await executeCoreLogic(deps, cfg, state.affiliates);
}

// Helper function to create initial incremental state
export function createInitialIncrementalState(): IncrementalState {
  return {
    initialized: false,
    lastSafeHeadScanned: 0,
    affiliates: new Set<string>(),
  };
}

// Helper function to process affiliate events efficiently
function processAffiliateEvents(
  events: AffiliateGroupChanged[],
  targetGroup: string,
  currentAffiliates: Set<string>,
  isInitialized: boolean
): void {
  if (!isInitialized) {
    currentAffiliates.clear();
  }
  
  // Sort events by block number to ensure correct order
  events.sort((a, b) => a.blockNumber - b.blockNumber);
  
  for (const e of events) {
    const human = e.human.toLowerCase();
    const newGroup = e.newGroup.toLowerCase();
    const oldGroup = e.oldGroup.toLowerCase();
    
    if (newGroup === targetGroup) {
      currentAffiliates.add(human);
    }
    if (oldGroup === targetGroup) {
      currentAffiliates.delete(human);
    }
  }
}
