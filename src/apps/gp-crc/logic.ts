import {getAddress} from "ethers";
import {IChainRpc} from "../../interfaces/IChainRpc";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../../interfaces/IBlacklistingService";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IGroupService} from "../../interfaces/IGroupService";
import {IAvatarSafeService} from "../../interfaces/IAvatarSafeService";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";

export type RunConfig = {
  rpcUrl: string;
  startAtBlock: number;
  confirmationBlocks: number;
  blockChunkSize?: number;
  blacklistChunkSize?: number;
  groupAddress: string;
  dryRun?: boolean;
  groupBatchSize?: number;
};

export type Deps = {
  chainRpc: IChainRpc;
  blacklistingService: IBlacklistingService;
  avatarSafeService: IAvatarSafeService;
  circlesRpc: ICirclesRpc;
  groupService?: IGroupService;
  logger: ILoggerService;
};

export type RunOutcome = {
  fromBlock: number;
  toBlock: number;
  processed: boolean;
  eventCount: number;
  uniqueAvatarCount: number;
  allowedAvatars: string[];
  blacklistedAvatars: string[];
  trustedAvatars: string[];
  trustTxHashes: string[];
  newLastProcessedBlock?: number;
};

type RegisterHumanEvent = {
  blockNumber: number;
  avatar: string;
  transactionHash?: string;
};

type CirclesEventsResponse = {
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type BlockRange = {
  from: number;
  to: number;
};

export const DEFAULT_BLOCK_CHUNK_SIZE = 50_0000;
export const DEFAULT_BLACKLIST_CHUNK_SIZE = 1000;
export const DEFAULT_GROUP_BATCH_SIZE = 10;

const EVENT_FETCH_TIMEOUT_MS = 30_000;
const EVENT_FETCH_MAX_ATTEMPTS = 3;
const EVENT_FETCH_RETRY_DELAY_MS = 2_000;

const BLACKLIST_FETCH_MAX_ATTEMPTS = 3;
const BLACKLIST_FETCH_RETRY_DELAY_MS = 2_000;

const TRUST_BATCH_MAX_ATTEMPTS = 3;
const TRUST_BATCH_RETRY_DELAY_MS = 1_500;

export async function runOnce(
  deps: Deps,
  cfg: RunConfig
): Promise<RunOutcome> {
  const {chainRpc, blacklistingService, avatarSafeService, circlesRpc, groupService, logger} = deps;
  const blockChunkSize = Math.max(1, cfg.blockChunkSize ?? DEFAULT_BLOCK_CHUNK_SIZE);
  const blacklistChunkSize = Math.max(1, cfg.blacklistChunkSize ?? DEFAULT_BLACKLIST_CHUNK_SIZE);
  const groupBatchSize = Math.max(1, cfg.groupBatchSize ?? DEFAULT_GROUP_BATCH_SIZE);
  const dryRun = !!cfg.dryRun;
  const groupAddress = normalizeAddress(cfg.groupAddress);

  if (!groupAddress) {
    throw new Error(`Invalid group address configured: '${cfg.groupAddress}'`);
  }

  if (!dryRun && !groupService) {
    throw new Error("Group service dependency is required when gp-crc is not running in dry-run mode");
  }

  const fromBlock = Math.max(0, cfg.startAtBlock);

  const head = await chainRpc.getHeadBlock();
  const safeHeadBlock = Math.max(0, head.blockNumber - cfg.confirmationBlocks);

  logger.info(`Head block: ${head.blockNumber}, safe head (with ${cfg.confirmationBlocks} confirmations): ${safeHeadBlock}`);

  if (fromBlock > safeHeadBlock) {
    logger.info(`No confirmed blocks to scan yet (next from ${fromBlock}). Waiting for more confirmations.`);
    return {
      fromBlock,
      toBlock: safeHeadBlock,
      processed: false,
      eventCount: 0,
      uniqueAvatarCount: 0,
      allowedAvatars: [],
      blacklistedAvatars: [],
      trustedAvatars: [],
      trustTxHashes: [],
      newLastProcessedBlock: safeHeadBlock
    };
  }

  logger.info(`Scanning RegisterHuman events in block range [${fromBlock}, ${safeHeadBlock}].`);

  const ranges = createBlockRanges(fromBlock, safeHeadBlock, blockChunkSize);
  const events: RegisterHumanEvent[] = [];

  for (const range of ranges) {
    const chunkEvents = await fetchRegisterHumanEvents(cfg.rpcUrl, range, logger);
    logger.debug(`Fetched ${chunkEvents.length} events for blocks [${range.from}, ${range.to}].`);
    events.push(...chunkEvents);
  }

  const avatars = events
    .map((event) => event.avatar)
    .filter((address): address is string => !!address);

  const uniqueAvatars = Array.from(new Set(avatars));
  logger.info(`Found ${events.length} RegisterHuman events with ${uniqueAvatars.length} unique avatars.`);

  if (uniqueAvatars.length === 0) {
    logger.info(`No avatars to evaluate against the blacklist.`);
    return {
      fromBlock,
      toBlock: safeHeadBlock,
      processed: true,
      eventCount: events.length,
      uniqueAvatarCount: 0,
      allowedAvatars: [],
      blacklistedAvatars: [],
      trustedAvatars: [],
      trustTxHashes: [],
      newLastProcessedBlock: safeHeadBlock
    };
  }

  const {allowed, blacklisted} = await partitionBlacklistedAddresses(
    blacklistingService,
    uniqueAvatars,
    blacklistChunkSize,
    logger
  );

  logger.info(
    `Avatar blacklist summary for [${fromBlock}, ${safeHeadBlock}]: ` +
    `${uniqueAvatars.length} unique (allowed ${allowed.length}, blacklisted ${blacklisted.length}).`
  );

  const eligibleAvatars: string[] = [];
  const avatarsWithoutSafe: string[] = [];
  if (allowed.length > 0) {
    logger.info(`Checking configured safes for ${allowed.length} allowed avatar(s).`);
    const avatarsWithSafes = await avatarSafeService.findAvatarsWithSafes(allowed);
    for (const avatar of allowed) {
      if (avatarsWithSafes.has(avatar)) {
        eligibleAvatars.push(avatar);
      } else {
        avatarsWithoutSafe.push(avatar);
      }
    }

    logger.info(
      `Avatar safe summary for [${fromBlock}, ${safeHeadBlock}]: ` +
      `${eligibleAvatars.length} with safes, ${avatarsWithoutSafe.length} without safes.`
    );

    if (avatarsWithoutSafe.length > 0) {
      logger.info(`Skipping ${avatarsWithoutSafe.length} avatar(s) without configured safes.`);
      if (dryRun) {
        logger.debug(`Avatars without safes: ${avatarsWithoutSafe.join(", ")}`);
      }
    }
  }

  const trustedAvatars: string[] = [];
  const trustTxHashes: string[] = [];

  let avatarsToTrust: string[] = [];
  let alreadyTrustedAvatars: string[] = [];

  if (eligibleAvatars.length > 0) {
    const partitioned = await partitionAlreadyTrustedAvatars(
      circlesRpc,
      groupAddress,
      eligibleAvatars,
      logger
    );
    avatarsToTrust = partitioned.toTrust;
    alreadyTrustedAvatars = partitioned.alreadyTrusted;

    if (alreadyTrustedAvatars.length > 0) {
      logger.info(
        `Skipping ${alreadyTrustedAvatars.length} avatar(s) already trusted in group ${groupAddress}.`
      );
      if (dryRun) {
        logger.debug(`Already trusted avatars: ${alreadyTrustedAvatars.join(", ")}`);
      }
    }
  }

  if (avatarsToTrust.length > 0) {
    const batches = chunkArray(avatarsToTrust, groupBatchSize);
    if (dryRun) {
      logger.info(
        `Dry-run mode enabled; would trust ${avatarsToTrust.length} avatar(s) in group ${groupAddress} across ${batches.length} batch(es).`
      );
      batches.forEach((batch, index) => {
        logger.info(`DRY RUN trust batch ${index + 1}/${batches.length}: ${batch.length} avatars.`);
      });
      trustedAvatars.push(...avatarsToTrust);
    } else {
      logger.info(`Trusting ${avatarsToTrust.length} avatar(s) in group ${groupAddress} across ${batches.length} batch(es).`);
      const concreteGroupService = groupService!;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        logger.info(`Trusting batch ${i + 1}/${batches.length} (${batch.length} avatars)...`);
        const txHash = await trustBatchWithRetry(
          concreteGroupService,
          groupAddress,
          batch,
          logger,
          i + 1,
          batches.length
        );
        logger.info(`  - trust tx hash: ${txHash}`);
        trustTxHashes.push(txHash);
        trustedAvatars.push(...batch);
      }
      logger.info(`Trusted ${trustedAvatars.length} avatars in total for group ${groupAddress}.`);
    }
  }

  return {
    fromBlock,
    toBlock: safeHeadBlock,
    processed: true,
    eventCount: events.length,
    uniqueAvatarCount: uniqueAvatars.length,
    allowedAvatars: allowed,
    blacklistedAvatars: blacklisted,
    trustedAvatars,
    trustTxHashes,
    newLastProcessedBlock: safeHeadBlock
  };
}

async function fetchRegisterHumanEvents(
  rpcUrl: string,
  range: BlockRange,
  logger: ILoggerService
): Promise<RegisterHumanEvent[]> {
  const payload = {
    jsonrpc: "2.0",
    id: `gp-crc-${range.from}-${range.to}`,
    method: "circles_events",
    params: [
      null,
      range.from,
      range.to,
      ["CrcV2_RegisterHuman"]
    ]
  };
  for (let attempt = 1; attempt <= EVENT_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await timedFetch(
        rpcUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        },
        EVENT_FETCH_TIMEOUT_MS
      );

      if (!response.ok) {
        const status = response.status;
        const error = new Error(`Failed to fetch RegisterHuman events: HTTP ${status} ${response.statusText}`);
        if (attempt < EVENT_FETCH_MAX_ATTEMPTS && isRetryableStatus(status)) {
          logger.warn(`Fetch attempt ${attempt} for blocks [${range.from}, ${range.to}] failed with status ${status}. Retrying in ${EVENT_FETCH_RETRY_DELAY_MS} ms.`);
          await wait(EVENT_FETCH_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }

      const body = await response.json() as CirclesEventsResponse;
      if (body.error) {
        throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
      }

      const rawEvents = Array.isArray(body.result) ? body.result : [];
      const parsedEvents: RegisterHumanEvent[] = [];
      let missingAvatarCount = 0;
      let missingBlockNumberCount = 0;

      for (const raw of rawEvents) {
        const parsed = parseRegisterHumanEvent(raw);
        if (parsed.ok) {
          parsedEvents.push(parsed.event);
        } else if (parsed.reason === "missing_avatar") {
          missingAvatarCount += 1;
        } else {
          missingBlockNumberCount += 1;
        }
      }

      const skippedCount = missingAvatarCount + missingBlockNumberCount;
      if (skippedCount > 0) {
        const reasons: string[] = [];
        if (missingBlockNumberCount > 0) {
          reasons.push(`missing or invalid block number: ${missingBlockNumberCount}`);
        }
        if (missingAvatarCount > 0) {
          reasons.push(`missing or invalid avatar address: ${missingAvatarCount}`);
        }
        logger.warn(`Skipped ${skippedCount} RegisterHuman events (${reasons.join(", ")}).`);
      }

      return parsedEvents;
    } catch (error) {
      const retryable = isRetryableFetchError(error);
      if (attempt >= EVENT_FETCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(`Fetch attempt ${attempt} for blocks [${range.from}, ${range.to}] failed (${formatErrorMessage(error)}). Retrying in ${EVENT_FETCH_RETRY_DELAY_MS} ms.`);
      await wait(EVENT_FETCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to fetch RegisterHuman events after retries");
}

async function partitionAlreadyTrustedAvatars(
  circlesRpc: ICirclesRpc,
  groupAddress: string,
  avatars: string[],
  logger: ILoggerService
): Promise<{alreadyTrusted: string[]; toTrust: string[]}> {
  const trustees = await circlesRpc.fetchAllTrustees(groupAddress);
  const normalizedTrustees = new Set<string>();

  for (const trustee of trustees) {
    const normalized = normalizeAddress(trustee);
    if (!normalized) {
      logger.debug(`Ignoring invalid trustee address returned for group ${groupAddress}: ${trustee}`);
      continue;
    }
    normalizedTrustees.add(normalized.toLowerCase());
  }

  const alreadyTrusted: string[] = [];
  const toTrust: string[] = [];

  for (const avatar of avatars) {
    if (normalizedTrustees.has(avatar.toLowerCase())) {
      alreadyTrusted.push(avatar);
    } else {
      toTrust.push(avatar);
    }
  }

  return {alreadyTrusted, toTrust};
}

type ParseFailureReason = "missing_block_number" | "missing_avatar";

type ParseRegisterHumanResult =
  | {ok: true; event: RegisterHumanEvent}
  | {ok: false; reason: ParseFailureReason};

function parseRegisterHumanEvent(raw: unknown): ParseRegisterHumanResult {
  if (typeof raw !== "object" || raw === null) {
    return {ok: false, reason: "missing_block_number"};
  }

  const obj = raw as Record<string, unknown>;
  const blockNumber = extractBlockNumber(obj);
  if (blockNumber === null) {
    return {ok: false, reason: "missing_block_number"};
  }

  const avatar = extractAvatar(obj);
  if (!avatar) {
    return {ok: false, reason: "missing_avatar"};
  }

  const transactionHash = extractHash(obj);
  return {
    ok: true,
    event: {
      blockNumber,
      avatar,
      transactionHash
    }
  };
}

function extractBlockNumber(obj: Record<string, unknown>): number | null {
  const sources: Record<string, unknown>[] = [obj];

  const values = obj["values"];
  if (values && typeof values === "object") {
    sources.push(values as Record<string, unknown>);
  }

  for (const source of sources) {
    const candidates = [
      source["blockNumber"],
      source["block_number"],
      source["block"],
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return candidate;
      }
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length === 0) {
          continue;
        }
        const parsed = trimmed.startsWith("0x") || trimmed.startsWith("0X")
          ? Number.parseInt(trimmed.slice(2), 16)
          : Number.parseInt(trimmed, 10);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }
    }
  }

  return null;
}

function extractAvatar(obj: Record<string, unknown>): string | null {
  const values = obj["values"];
  if (!values || typeof values !== "object") {
    return null;
  }

  const avatar = (values as Record<string, unknown>)["avatar"];
  if (typeof avatar !== "string") {
    return null;
  }

  return normalizeAddress(avatar);
}

function extractHash(obj: Record<string, unknown>): string | undefined {
  const sources: Record<string, unknown>[] = [obj];

  const values = obj["values"];
  if (values && typeof values === "object") {
    sources.push(values as Record<string, unknown>);
  }

  for (const source of sources) {
    const candidates = [
      source["transactionHash"],
      source["transaction_hash"],
      source["txHash"],
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return undefined;
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

function createBlockRanges(from: number, to: number, chunkSize: number): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (let start = from; start <= to; start += chunkSize) {
    const end = Math.min(to, start + chunkSize - 1);
    ranges.push({from: start, to: end});
  }
  return ranges;
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
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
        logger.warn(`No verdict returned for ${address}; treating as allowed.`);
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

async function trustBatchWithRetry(
  service: IGroupService,
  groupAddress: string,
  batch: string[],
  logger: ILoggerService,
  currentBatch: number,
  totalBatches: number
): Promise<string> {
  for (let attempt = 1; attempt <= TRUST_BATCH_MAX_ATTEMPTS; attempt++) {
    try {
      logger.debug(`Trust batch ${currentBatch}/${totalBatches} attempt ${attempt}/${TRUST_BATCH_MAX_ATTEMPTS}.`);
      return await service.trustBatchWithConditions(groupAddress, batch);
    } catch (error) {
      const retryable = isRetryableTrustError(error);
      if (attempt >= TRUST_BATCH_MAX_ATTEMPTS || !retryable) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      logger.warn(`Trust batch ${currentBatch}/${totalBatches} attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${TRUST_BATCH_RETRY_DELAY_MS} ms.`);
      await wait(TRUST_BATCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to trust batch after retries");
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

      logger.warn(`Blacklist check attempt ${attempt} failed (${formatErrorMessage(error)}). Retrying in ${BLACKLIST_FETCH_RETRY_DELAY_MS} ms.`);
      await wait(BLACKLIST_FETCH_RETRY_DELAY_MS);
    }
  }

  throw new Error("Failed to fetch blacklist verdicts after retries");
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
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

function isRetryableTrustError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return true;
  }

  const anyError = error as { code?: unknown; message?: unknown };
  const code = typeof anyError.code === "string" ? anyError.code.toUpperCase() : "";
  const message = typeof anyError.message === "string" ? anyError.message.toLowerCase() : "";

  if (code === "CALL_EXCEPTION" || code === "UNPREDICTABLE_GAS_LIMIT" || code === "INSUFFICIENT_FUNDS") {
    return false;
  }

  if (code.includes("NETWORK") || code.includes("SERVER") || code.includes("TIMEOUT")) {
    return true;
  }

  if (message.includes("timeout") || message.includes("network") || message.includes("econnreset") || message.includes("temporarily")) {
    return true;
  }

  if (message.includes("insufficient funds") || message.includes("underpriced") || message.includes("nonce")) {
    return false;
  }

  return false;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
