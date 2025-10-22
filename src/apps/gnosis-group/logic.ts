import {getAddress} from "ethers";
import {CirclesQuery, CirclesRpc} from "@circles-sdk/data";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../../interfaces/IBlacklistingService";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IGroupService} from "../../interfaces/IGroupService";

type RegisterHumanRow = {
  avatar?: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  timestamp?: number;
};

type RelativeTrustScoreEntry = {
  address?: string;
  relative_score?: number;
  targets_reached?: number;
  total_targets?: number;
  penetration_rate?: number;
};

type RelativeTrustScoreResponse = {
  status?: string;
  batches?: Record<string, RelativeTrustScoreEntry[]>;
};

export type RunConfig = {
  rpcUrl: string;
  scoringServiceUrl: string;
  circlesBackerGroupAddress: string;
  targetGroupAddress: string;
  autoTrustGroupAddresses?: string[];
  fetchPageSize?: number;
  blacklistChunkSize?: number;
  scoreBatchSize?: number;
  scoreThreshold?: number;
  groupBatchSize?: number;
  dryRun?: boolean;
};

export type Deps = {
  blacklistingService: IBlacklistingService;
  circlesRpc: ICirclesRpc;
  logger: ILoggerService;
  groupService?: IGroupService;
};

export type RunOutcome = {
  totalHumanAvatars: number;
  uniqueHumanAvatars: number;
  allowedAvatars: string[];
  blacklistedAvatars: string[];
  trustedTargetCount: number;
  scoredAddresses: number;
  threshold: number;
  aboveThresholdCount: number;
  scores: Record<string, number>;
  targetGroupAddress: string;
  targetGroupTrusteeCount: number;
  addressesAboveThresholdToTrust: string[];
  addressesAutoTrustedByGroups: string[];
  addressesQueuedForTrust: string[];
  trustBatchSize: number;
  trustBatches: string[][];
  trustTxHashes: string[];
  addressesToUntrust: string[];
  untrustBatches: string[][];
  untrustTxHashes: string[];
};

export const DEFAULT_FETCH_PAGE_SIZE = 1_000;
export const DEFAULT_BLACKLIST_CHUNK_SIZE = 500;
export const DEFAULT_SCORE_BATCH_SIZE = 20;
export const DEFAULT_SCORE_THRESHOLD = 50;
export const DEFAULT_GROUP_BATCH_SIZE = 10;
export const DEFAULT_AUTO_TRUST_GROUP_ADDRESSES = [
  "0x33ef4988f3afd1c9b2cba42862976cae1711d608",
  "0xb629a1e86f3efada0f87c83494da8cc34c3f84ef"
] as const;

const BLACKLIST_FETCH_MAX_ATTEMPTS = 3;
const BLACKLIST_FETCH_RETRY_DELAY_MS = 2_000;

const SCORE_FETCH_TIMEOUT_MS = 30_000;
const SCORE_FETCH_MAX_ATTEMPTS = 3;
const SCORE_FETCH_RETRY_DELAY_MS = 2_000;
const GROUP_BATCH_MAX_ATTEMPTS = 3;
const GROUP_BATCH_RETRY_DELAY_MS = 2_000;

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<RunOutcome> {
  const {blacklistingService, circlesRpc, groupService, logger} = deps;
  const fetchPageSize = Math.max(1, cfg.fetchPageSize ?? DEFAULT_FETCH_PAGE_SIZE);
  const blacklistChunkSize = Math.max(1, cfg.blacklistChunkSize ?? DEFAULT_BLACKLIST_CHUNK_SIZE);
  const scoreBatchSize = Math.max(1, cfg.scoreBatchSize ?? DEFAULT_SCORE_BATCH_SIZE);
  const scoreThreshold = cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const groupBatchSize = Math.max(1, cfg.groupBatchSize ?? DEFAULT_GROUP_BATCH_SIZE);
  const dryRun = !!cfg.dryRun;

  const targetGroupAddress = normalizeAddress(cfg.targetGroupAddress);
  if (!targetGroupAddress) {
    throw new Error(`Invalid target group address configured: '${cfg.targetGroupAddress}'`);
  }

  const circlesBackerGroupAddress = normalizeAddress(cfg.circlesBackerGroupAddress);
  if (!circlesBackerGroupAddress) {
    throw new Error(`Invalid circles backer group address configured: '${cfg.circlesBackerGroupAddress}'`);
  }

  if (!dryRun && !groupService) {
    throw new Error("Group service dependency is required when gnosis-group is not running in dry-run mode");
  }

  const loggerHuman = logger.child("humans");
  const loggerBlacklist = logger.child("blacklist");
  const loggerScores = logger.child("scores");
  const loggerTrust = logger.child("trust");

  const humanAvatars = await fetchAllHumanAvatars(cfg.rpcUrl, fetchPageSize, loggerHuman);
  const uniqueHumanAvatars = Array.from(new Set(humanAvatars));

  loggerHuman.info(`Fetched ${humanAvatars.length} human avatar entries (${uniqueHumanAvatars.length} unique).`);

  if (uniqueHumanAvatars.length === 0) {
    logger.info("No human avatars found; skipping scoring.");
    return {
      totalHumanAvatars: 0,
      uniqueHumanAvatars: 0,
      allowedAvatars: [],
      blacklistedAvatars: [],
      trustedTargetCount: 0,
      scoredAddresses: 0,
      threshold: scoreThreshold,
      aboveThresholdCount: 0,
      scores: {},
      targetGroupAddress,
      targetGroupTrusteeCount: 0,
      addressesAboveThresholdToTrust: [],
      addressesAutoTrustedByGroups: [],
      addressesQueuedForTrust: [],
      trustBatchSize: groupBatchSize,
      trustBatches: [],
      trustTxHashes: [],
      addressesToUntrust: [],
      untrustBatches: [],
      untrustTxHashes: []
    };
  }

  if (dryRun) {
    loggerBlacklist.info(
      `Dry-run mode enabled; evaluating blacklist for ${uniqueHumanAvatars.length} avatar(s).`
    );
    if (uniqueHumanAvatars.length > 0) {
      const batches = chunkArray(uniqueHumanAvatars, blacklistChunkSize);
      loggerBlacklist.debug(
        `Dry-run: evaluating blacklist in ${batches.length} batch(es) of up to ${blacklistChunkSize} address(es).`
      );
    }
  }

  const {allowed: allowedAvatars, blacklisted: blacklistedAvatars} = await partitionBlacklistedAddresses(
    blacklistingService,
    uniqueHumanAvatars,
    blacklistChunkSize,
    loggerBlacklist
  );

  if (dryRun && blacklistedAvatars.length > 0) {
    loggerBlacklist.info(
      `Dry-run mode enabled; blacklist service flagged ${blacklistedAvatars.length} avatar(s).`
    );
  }

  loggerBlacklist.info(
    `Blacklist evaluation complete. Allowed: ${allowedAvatars.length}, blacklisted: ${blacklistedAvatars.length}.`
  );

  if (allowedAvatars.length === 0) {
    logger.info("No avatars remain after blacklist filtering; skipping scoring.");
    return {
      totalHumanAvatars: humanAvatars.length,
      uniqueHumanAvatars: uniqueHumanAvatars.length,
      allowedAvatars,
      blacklistedAvatars,
      trustedTargetCount: 0,
      scoredAddresses: 0,
      threshold: scoreThreshold,
      aboveThresholdCount: 0,
      scores: {},
      targetGroupAddress,
      targetGroupTrusteeCount: 0,
      addressesAboveThresholdToTrust: [],
      addressesAutoTrustedByGroups: [],
      addressesQueuedForTrust: [],
      trustBatchSize: groupBatchSize,
      trustBatches: [],
      trustTxHashes: [],
      addressesToUntrust: [],
      untrustBatches: [],
      untrustTxHashes: []
    };
  }

  const trustedTargetsRaw = await circlesRpc.fetchAllTrustees(circlesBackerGroupAddress);
  const trustedTargets = uniqueNormalizedAddresses(trustedTargetsRaw);

  logger.info(`Fetched ${trustedTargets.length} trusted addresses from circles backer group ${circlesBackerGroupAddress}.`);

  if (trustedTargets.length === 0) {
    throw new Error(`No trusted addresses found for circles backer group ${circlesBackerGroupAddress}.`);
  }

  const scores: Record<string, number> = {};
  let totalScored = 0;

  const scoreBatches = chunkArray(allowedAvatars, scoreBatchSize);
  if (dryRun) {
    if (scoreBatches.length === 0) {
      loggerScores.info("Dry-run mode enabled; no avatars to score.");
    } else {
      loggerScores.info(
        `Dry-run mode enabled; requesting ${scoreBatches.length} relative trust score batch request(s) for ${allowedAvatars.length} avatar(s).`
      );
    }
  }

  for (const [batchIndex, batch] of scoreBatches.entries()) {
    if (dryRun) {
      loggerScores.debug(
        `Dry-run score batch ${batchIndex + 1}/${scoreBatches.length}: ${batch.length} avatar(s) -> ${batch.join(", ")}.`
      );
    } else {
      loggerScores.debug(`Requesting relative trust scores for batch ${batchIndex + 1}.`);
    }

    const batchScores = await fetchRelativeTrustScoresWithRetry(
      cfg.scoringServiceUrl,
      batch,
      trustedTargets,
      loggerScores
    );
    for (const [address, score] of batchScores.entries()) {
      if (!(address in scores)) {
        totalScored += 1;
      }
      scores[address] = score;
    }
  }

  if (totalScored === 0) {
    if (dryRun) {
      logger.info("Dry-run mode enabled; relative trust score service returned no scores.");
    } else {
      logger.warn("Relative trust score service returned no scores.");
    }
  } else {
    const message = dryRun
      ? `Dry-run mode enabled; received relative scores for ${totalScored} avatar(s).`
      : `Received relative scores for ${totalScored} avatars.`;
    logger.info(message);
  }

  let aboveThresholdCount = 0;
  for (const address of allowedAvatars) {
    const normalized = normalizeAddress(address);
    if (!normalized) {
      continue;
    }
    const score = scores[normalized] ?? 0;
    if (score > scoreThreshold) {
      aboveThresholdCount += 1;
    }
  }

  logger.info(`Addresses with relative score > ${scoreThreshold}: ${aboveThresholdCount}.`);

  const configuredAutoTrustGroups = cfg.autoTrustGroupAddresses ?? [];
  const autoTrustGroupAddresses = uniqueNormalizedAddresses([
    circlesBackerGroupAddress,
    ...DEFAULT_AUTO_TRUST_GROUP_ADDRESSES,
    ...configuredAutoTrustGroups
  ]);

  const autoTrustedLowercase = new Set<string>();
  for (const address of trustedTargets) {
    autoTrustedLowercase.add(address.toLowerCase());
  }

  for (const groupAddress of autoTrustGroupAddresses) {
    if (groupAddress.toLowerCase() === circlesBackerGroupAddress.toLowerCase()) {
      continue;
    }
    const trusteesRaw = await circlesRpc.fetchAllTrustees(groupAddress);
    const trustees = uniqueNormalizedAddresses(trusteesRaw);
    loggerTrust.info(`Fetched ${trustees.length} trusted addresses from auto-trust group ${groupAddress}.`);
    for (const trustee of trustees) {
      autoTrustedLowercase.add(trustee.toLowerCase());
    }
  }

  const targetGroupTrusteesRaw = await circlesRpc.fetchAllTrustees(targetGroupAddress);
  const targetGroupTrustees = uniqueNormalizedAddresses(targetGroupTrusteesRaw);
  const targetGroupTrusteesLowercase = new Set(targetGroupTrustees.map((addr) => addr.toLowerCase()));

  loggerTrust.info(
    `Target group ${targetGroupAddress} currently has ${targetGroupTrustees.length} trusted address(es).`
  );

  const trustPlan = computeTrustPlan({
    allowedAvatars,
    scores,
    scoreThreshold,
    guaranteedLowercase: autoTrustedLowercase,
    existingTargetGroupAddresses: targetGroupTrustees,
    batchSize: groupBatchSize
  });

  const trustTxHashes: string[] = [];
  const untrustTxHashes: string[] = [];

  loggerTrust.info(
    `Trust plan prepared: ${trustPlan.addressesQueuedForTrust.length} address(es) to trust ` +
    `(above threshold: ${trustPlan.addressesAboveThresholdToTrust.length}, ` +
    `trusted by configured groups: ${trustPlan.addressesAutoTrustedByGroups.length}) ` +
    `in ${trustPlan.trustBatches.length} batch(es) of up to ${groupBatchSize}.`
  );

  if (trustPlan.addressesToUntrust.length > 0) {
    loggerTrust.info(
      `Untrust plan prepared: ${trustPlan.addressesToUntrust.length} address(es) to untrust in ${trustPlan.untrustBatches.length} batch(es).`
    );
  } else {
    loggerTrust.info("No addresses scheduled for untrust in the prepared plan.");
  }

  const untrustFailures: BatchFailure[] = [];
  const trustFailures: BatchFailure[] = [];

  if (trustPlan.untrustBatches.length > 0) {
    if (dryRun) {
      loggerTrust.info("Dry-run mode enabled; skipping untrust transactions for prepared batches.");
      trustPlan.untrustBatches.forEach((batch, index) => {
        loggerTrust.debug(`Dry-run untrust batch ${index + 1}/${trustPlan.untrustBatches.length}: ${batch.join(", ")}`);
      });
    } else {
      if (!groupService) {
        throw new Error("Group service dependency missing; cannot execute untrust batches.");
      }
      for (const [batchIndex, batch] of trustPlan.untrustBatches.entries()) {
        loggerTrust.info(
          `Untrusting batch ${batchIndex + 1}/${trustPlan.untrustBatches.length} (${batch.length} address(es)).`
        );
        loggerTrust.debug(`Untrust batch ${batchIndex + 1} addresses: ${batch.join(", ")}`);
        try {
          const txHash = await performBatchOperationWithRetry(
            "untrust",
            batchIndex,
            trustPlan.untrustBatches.length,
            batch,
            () => groupService.untrustBatch(targetGroupAddress, batch),
            loggerTrust
          );
          untrustTxHashes.push(txHash);
          batch.forEach((address) => targetGroupTrusteesLowercase.delete(address.toLowerCase()));
          loggerTrust.info(
            `Untrust batch ${batchIndex + 1}/${trustPlan.untrustBatches.length} succeeded (tx=${txHash}).`
          );
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          untrustFailures.push({
            action: "untrust",
            batch,
            batchIndex,
            error: err
          });
        }
      }
    }
  } else {
    loggerTrust.info("No addresses to untrust for the configured group.");
  }

  if (trustPlan.trustBatches.length > 0) {
    if (dryRun) {
      loggerTrust.info("Dry-run mode enabled; skipping trust transactions for prepared batches.");
      trustPlan.trustBatches.forEach((batch, index) => {
        loggerTrust.debug(`Dry-run trust batch ${index + 1}/${trustPlan.trustBatches.length}: ${batch.join(", ")}`);
      });
    } else {
      if (!groupService) {
        throw new Error("Group service dependency missing; cannot execute trust batches.");
      }
      for (const [batchIndex, batch] of trustPlan.trustBatches.entries()) {
        const filteredBatch = batch.filter((address) => {
          const lower = address.toLowerCase();
          if (targetGroupTrusteesLowercase.has(lower)) {
            loggerTrust.debug(
              `Skipping ${address} in batch ${batchIndex + 1}/${trustPlan.trustBatches.length}: already trusted.`
            );
            return false;
          }
          return true;
        });

        if (filteredBatch.length === 0) {
          loggerTrust.info(
            `Skipping trust batch ${batchIndex + 1}/${trustPlan.trustBatches.length}; all address(es) already trusted.`
          );
          continue;
        }

        loggerTrust.info(
          `Trusting batch ${batchIndex + 1}/${trustPlan.trustBatches.length} (${filteredBatch.length} address(es)).`
        );
        loggerTrust.debug(`Batch ${batchIndex + 1} addresses: ${filteredBatch.join(", ")}`);
        try {
          const txHash = await performBatchOperationWithRetry(
            "trust",
            batchIndex,
            trustPlan.trustBatches.length,
            filteredBatch,
            () => groupService.trustBatchWithConditions(targetGroupAddress, filteredBatch),
            loggerTrust
          );
          trustTxHashes.push(txHash);
          filteredBatch.forEach((address) => targetGroupTrusteesLowercase.add(address.toLowerCase()));
          loggerTrust.info(
            `Batch ${batchIndex + 1}/${trustPlan.trustBatches.length} succeeded (tx=${txHash}).`
          );
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          trustFailures.push({
            action: "trust",
            batch: filteredBatch,
            batchIndex,
            error: err
          });
        }
      }
    }
  } else {
    loggerTrust.info("No new addresses to trust for the configured group.");
  }

  if (untrustFailures.length > 0 || trustFailures.length > 0) {
    const summaryParts: string[] = [];
    untrustFailures.forEach((failure) => {
      summaryParts.push(
        `untrust batch ${failure.batchIndex + 1} (${failure.batch.join(", ")}) -> ${formatErrorMessage(failure.error)}`
      );
    });
    trustFailures.forEach((failure) => {
      summaryParts.push(
        `trust batch ${failure.batchIndex + 1} (${failure.batch.join(", ")}) -> ${formatErrorMessage(failure.error)}`
      );
    });

    throw new Error(
      `Failed to process ${summaryParts.length} group batch(es): ${summaryParts.join("; ")}`
    );
  }

  return {
    totalHumanAvatars: humanAvatars.length,
    uniqueHumanAvatars: uniqueHumanAvatars.length,
    allowedAvatars,
    blacklistedAvatars,
    trustedTargetCount: trustedTargets.length,
    scoredAddresses: totalScored,
    threshold: scoreThreshold,
    aboveThresholdCount,
    scores,
    targetGroupAddress,
    targetGroupTrusteeCount: targetGroupTrustees.length,
    addressesAboveThresholdToTrust: trustPlan.addressesAboveThresholdToTrust,
    addressesAutoTrustedByGroups: trustPlan.addressesAutoTrustedByGroups,
    addressesQueuedForTrust: trustPlan.addressesQueuedForTrust,
    trustBatchSize: groupBatchSize,
    trustBatches: trustPlan.trustBatches,
    trustTxHashes,
    addressesToUntrust: trustPlan.addressesToUntrust,
    untrustBatches: trustPlan.untrustBatches,
    untrustTxHashes
  };
}

type ComputeTrustPlanInput = {
  allowedAvatars: string[];
  scores: Record<string, number>;
  scoreThreshold: number;
  guaranteedLowercase: Set<string>;
  existingTargetGroupAddresses: string[];
  batchSize: number;
};

export type TrustPlan = {
  addressesAboveThresholdToTrust: string[];
  addressesAutoTrustedByGroups: string[];
  addressesQueuedForTrust: string[];
  trustBatches: string[][];
  addressesToUntrust: string[];
  untrustBatches: string[][];
};

export function computeTrustPlan(input: ComputeTrustPlanInput): TrustPlan {
  const effectiveBatchSize = Math.max(1, input.batchSize);
  const addressesAboveThresholdToTrust: string[] = [];
  const addressesAutoTrustedByGroups: string[] = [];
  const addressesQueuedForTrust: string[] = [];
  const addressesToUntrust: string[] = [];
  const queuedLowercase = new Set<string>();
  const satisfiedLowercase = new Set<string>();
  const existingLowercase = new Set<string>();

  for (const existing of input.existingTargetGroupAddresses) {
    const normalizedExisting = normalizeAddress(existing);
    if (!normalizedExisting) {
      continue;
    }
    existingLowercase.add(normalizedExisting.toLowerCase());
  }

  for (const raw of input.allowedAvatars) {
    const normalized = normalizeAddress(raw);
    if (!normalized) {
      continue;
    }

    const lower = normalized.toLowerCase();
    const score = getScoreForAddress(input.scores, normalized);
    const aboveThreshold = score > input.scoreThreshold;
    const guaranteed = input.guaranteedLowercase.has(lower);

    if (!aboveThreshold && !guaranteed) {
      continue;
    }

    satisfiedLowercase.add(lower);

    if (existingLowercase.has(lower) || queuedLowercase.has(lower)) {
      continue;
    }

    if (aboveThreshold) {
      addressesAboveThresholdToTrust.push(normalized);
    } else {
      addressesAutoTrustedByGroups.push(normalized);
    }

    queuedLowercase.add(lower);
    addressesQueuedForTrust.push(normalized);
  }

  for (const guaranteedLower of input.guaranteedLowercase) {
    satisfiedLowercase.add(guaranteedLower);
  }

  for (const existing of input.existingTargetGroupAddresses) {
    const normalizedExisting = normalizeAddress(existing);
    if (!normalizedExisting) {
      continue;
    }

    const lower = normalizedExisting.toLowerCase();
    if (!satisfiedLowercase.has(lower)) {
      addressesToUntrust.push(normalizedExisting);
    }
  }

  const trustBatches = chunkArray(addressesQueuedForTrust, effectiveBatchSize);
  const untrustBatches = chunkArray(addressesToUntrust, effectiveBatchSize);

  return {
    addressesAboveThresholdToTrust,
    addressesAutoTrustedByGroups,
    addressesQueuedForTrust,
    trustBatches,
    addressesToUntrust,
    untrustBatches
  };
}

function uniqueNormalizedAddresses(addresses: Iterable<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const candidate of addresses) {
    if (typeof candidate !== "string") {
      continue;
    }
    const normalized = normalizeAddress(candidate);
    if (!normalized) {
      continue;
    }
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    result.push(normalized);
  }

  return result;
}

async function fetchAllHumanAvatars(
  rpcUrl: string,
  pageSize: number,
  logger: ILoggerService
): Promise<string[]> {
  const rpc = new CirclesRpc(rpcUrl);
  const query = new CirclesQuery<RegisterHumanRow>(rpc, {
    namespace: "CrcV2",
    table: "RegisterHuman",
    // Include pagination columns required by CirclesQuery so cursor filters work on subsequent pages.
    columns: ["avatar", "blockNumber", "transactionIndex", "logIndex"],
    sortOrder: "ASC",
    limit: pageSize
  });

  const avatars: string[] = [];
  let pages = 0;

  while (await query.queryNextPage()) {
    pages += 1;
    const rows = query.currentPage?.results ?? [];
    for (const row of rows) {
      if (!row || typeof row.avatar !== "string") {
        continue;
      }

      const normalized = normalizeAddress(row.avatar);
      if (normalized) {
        avatars.push(normalized);
      }
    }
  }

  logger.info(`Fetched ${avatars.length} avatars from RegisterHuman table across ${pages} page(s).`);

  return avatars;
}

async function partitionBlacklistedAddresses(
  service: IBlacklistingService,
  addresses: string[],
  chunkSize: number,
  logger: ILoggerService
): Promise<{allowed: string[]; blacklisted: string[]}> {
  const allowed: string[] = [];
  const blacklisted: string[] = [];

  for (let i = 0; i < addresses.length; i += chunkSize) {
    const chunk = addresses.slice(i, i + chunkSize);
    const verdicts = await fetchBlacklistVerdictsWithRetry(service, chunk, logger);
    const verdictMap = new Map<string, IBlacklistServiceVerdict>();

    for (const verdict of verdicts) {
      verdictMap.set(verdict.address.toLowerCase(), verdict);
    }

    for (const address of chunk) {
      const verdict = verdictMap.get(address.toLowerCase());
      if (!verdict) {
        logger.warn(`No blacklist verdict returned for ${address}; treating as allowed.`);
        allowed.push(address);
        continue;
      }

      if (isBlacklisted(verdict)) {
        blacklisted.push(address);
      } else {
        allowed.push(address);
      }
    }
  }

  return {allowed, blacklisted};
}

async function fetchRelativeTrustScoresWithRetry(
  scoringUrl: string,
  avatars: string[],
  trustedTargets: string[],
  logger: ILoggerService
): Promise<Map<string, number>> {
  for (let attempt = 1; attempt <= SCORE_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchRelativeTrustScores(scoringUrl, avatars, trustedTargets);
    } catch (error) {
      const retryable = isRetryableFetchError(error);
      if (attempt >= SCORE_FETCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(
        `Relative trust score request attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${SCORE_FETCH_RETRY_DELAY_MS} ms.`
      );
      await wait(SCORE_FETCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to fetch relative trust scores after retries.");
}

async function fetchRelativeTrustScores(
  scoringUrl: string,
  avatars: string[],
  trustedTargets: string[]
): Promise<Map<string, number>> {
  const response = await timedFetch(
    scoringUrl,
    {
      method: "POST",
      headers: {
        "accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        avatar_batches: [avatars],
        target_sets: [trustedTargets]
      })
    },
    SCORE_FETCH_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Relative trust score request failed: HTTP ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as RelativeTrustScoreResponse;
  if (!payload || typeof payload !== "object" || payload.status !== "success" || !payload.batches) {
    throw new Error("Relative trust score response malformed: missing success status or batches.");
  }

  const results = new Map<string, number>();
  const batches = payload.batches;

  for (const batchKey of Object.keys(batches)) {
    const entries = batches[batchKey];
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (!entry || typeof entry.address !== "string") {
        continue;
      }

      const normalized = normalizeAddress(entry.address);
      if (!normalized) {
        continue;
      }

      const rawScore = typeof entry.relative_score === "number"
        ? entry.relative_score
        : Number(entry.relative_score);

      if (!Number.isFinite(rawScore)) {
        continue;
      }

      results.set(normalized, rawScore);
    }
  }

  return results;
}

type BatchFailure = {
  action: "trust" | "untrust";
  batch: string[];
  batchIndex: number;
  error: Error;
};

async function performBatchOperationWithRetry(
  action: "trust" | "untrust",
  batchIndex: number,
  totalBatches: number,
  batch: string[],
  operation: () => Promise<string>,
  logger: ILoggerService
): Promise<string> {
  let lastError: unknown;
  const actionLabel = action === "trust" ? "Trust" : "Untrust";

  for (let attempt = 1; attempt <= GROUP_BATCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = formatErrorMessage(error);
      if (attempt < GROUP_BATCH_MAX_ATTEMPTS) {
        logger.warn(
          `${actionLabel} batch ${batchIndex + 1}/${totalBatches} attempt ${attempt}/${GROUP_BATCH_MAX_ATTEMPTS} failed (${message}). Retrying in ${GROUP_BATCH_RETRY_DELAY_MS} ms.`
        );
        await wait(GROUP_BATCH_RETRY_DELAY_MS);
      } else {
        logger.error(
          `${actionLabel} batch ${batchIndex + 1}/${totalBatches} failed after ${GROUP_BATCH_MAX_ATTEMPTS} attempt(s): ${message}`
        );
      }
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("Unknown error while processing group batch.");
}

async function fetchBlacklistVerdictsWithRetry(
  service: IBlacklistingService,
  chunk: string[],
  logger: ILoggerService
): Promise<IBlacklistServiceVerdict[]> {
  for (let attempt = 1; attempt <= BLACKLIST_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await service.checkBlacklist(chunk);
    } catch (error) {
      const retryable = isRetryableFetchError(error);
      if (attempt >= BLACKLIST_FETCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(
        `Blacklist check attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${BLACKLIST_FETCH_RETRY_DELAY_MS} ms.`
      );
      await wait(BLACKLIST_FETCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to fetch blacklist verdicts after retries.");
}

function isBlacklisted(verdict: IBlacklistServiceVerdict): boolean {
  if (verdict.is_bot) {
    return true;
  }

  if (!verdict.category) {
    return false;
  }

  const category = verdict.category.toLowerCase();
  return category === "blocked" || category === "flagged";
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {...init, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function getScoreForAddress(scores: Record<string, number>, normalizedAddress: string): number {
  const direct = scores[normalizedAddress];
  if (typeof direct === "number") {
    return direct;
  }

  const lower = scores[normalizedAddress.toLowerCase()];
  if (typeof lower === "number") {
    return lower;
  }

  const upper = scores[normalizedAddress.toUpperCase()];
  if (typeof upper === "number") {
    return upper;
  }

  return 0;
}

function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return getAddress(trimmed);
  } catch {
    return null;
  }
}

function isRetryableFetchError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return true;
  }

  const anyError = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof anyError.name === "string" ? anyError.name.toLowerCase() : "";
  const code = typeof anyError.code === "string" ? anyError.code.toUpperCase() : "";
  const message = typeof anyError.message === "string" ? anyError.message.toLowerCase() : "";

  if (code.includes("TIMEOUT") || code.includes("NETWORK") || code.includes("SERVER")) {
    return true;
  }

  if (name === "aborterror") {
    return true;
  }

  if (message.includes("timeout") || message.includes("network") || message.includes("econnreset") || message.includes("temporarily")) {
    return true;
  }

  return false;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
