import {CirclesData} from "@circles-sdk/data";
import {Address} from "@circles-sdk/utils";
import {getAddress} from "ethers";
import {ICirclesRpc} from "../../interfaces/ICirclesRpc";
import {ILoggerService} from "../../interfaces/ILoggerService";
import {IRouterService} from "../../interfaces/IRouterService";

export type RunConfig = {
  rpcUrl: string;
  routerAddress: string;
  dryRun?: boolean;
  enableBatchSize?: number;
  baseGroupPageSize?: number;
  avatarInfoBatchSize?: number;
};

export type Deps = {
  circlesRpc: ICirclesRpc;
  routerService?: IRouterService;
  logger: ILoggerService;
};

export type BaseGroupPlan = {
  baseGroup: string;
  addresses: string[];
};

export type RunOutcome = {
  baseGroupCount: number;
  routerTrustCount: number;
  humanTrustCount: number;
  pendingTrustCount: number;
  executedTrustCount: number;
  dryRun: boolean;
  txHashes: string[];
  plans: BaseGroupPlan[];
};

export const DEFAULT_BASE_GROUP_PAGE_SIZE = 200;
export const DEFAULT_ENABLE_BATCH_SIZE = 10;
export const DEFAULT_AVATAR_INFO_BATCH_SIZE = 50;

export async function runOnce(deps: Deps, cfg: RunConfig): Promise<RunOutcome> {
  const {circlesRpc, routerService, logger} = deps;
  const dryRun = !!cfg.dryRun;
  const routerAddress = normalizeAddress(cfg.routerAddress);

  if (!routerAddress) {
    throw new Error(`Invalid router address configured: '${cfg.routerAddress}'`);
  }

  if (!dryRun && !routerService) {
    throw new Error("Router service dependency is required when router-tms is not running in dry-run mode.");
  }

  const enableBatchSize = Math.max(1, cfg.enableBatchSize ?? DEFAULT_ENABLE_BATCH_SIZE);
  const baseGroupPageSize = Math.max(1, cfg.baseGroupPageSize ?? DEFAULT_BASE_GROUP_PAGE_SIZE);
  const avatarInfoBatchSize = Math.max(1, cfg.avatarInfoBatchSize ?? DEFAULT_AVATAR_INFO_BATCH_SIZE);

  const dataClient = new CirclesData(cfg.rpcUrl);

  logger.info("Fetching base groups...");
  const baseGroups = await fetchAllBaseGroups(circlesRpc, baseGroupPageSize, logger);
  logger.info(`Identified ${baseGroups.length} base group(s).`);

  if (baseGroups.length === 0) {
    return {
      baseGroupCount: 0,
      routerTrustCount: 0,
      humanTrustCount: 0,
      pendingTrustCount: 0,
      executedTrustCount: 0,
      dryRun,
      txHashes: [],
      plans: []
    };
  }

  logger.info(`Fetching router trust list for ${routerAddress}...`);
  const routerTrustees = await circlesRpc.fetchAllTrustees(routerAddress);
  const routerTrustSet = new Set<string>();
  for (const trustee of routerTrustees) {
    const normalized = normalizeAddress(trustee);
    if (normalized) {
      routerTrustSet.add(normalized);
    }
  }
  logger.info(`Router currently trusts ${routerTrustSet.size} address(es).`);

  logger.info("Collecting outgoing trusts for each base group...");
  const baseGroupTrusts = await collectBaseGroupTrusts(baseGroups, circlesRpc, logger);

  const unionTrustees = new Set<string>();
  for (const trustees of baseGroupTrusts.values()) {
    trustees.forEach((address) => unionTrustees.add(address));
  }

  logger.info(
    `Discovered ${unionTrustees.size} unique trustee address(es) across all base groups. Filtering for human v2 avatars...`
  );
  const humanV2Addresses = await filterHumanV2Addresses(
    dataClient,
    Array.from(unionTrustees),
    avatarInfoBatchSize,
    logger
  );
  logger.info(`Filtered down to ${humanV2Addresses.size} human v2 trustee address(es).`);

  const plannedAddressesLower = new Set<string>();
  const planMap = new Map<string, string[]>();

  for (const [baseGroup, trustees] of baseGroupTrusts.entries()) {
    const humanTrustees = trustees.filter((address) => humanV2Addresses.has(address));
    if (humanTrustees.length === 0) {
      continue;
    }

    for (const trustee of humanTrustees) {
      if (routerTrustSet.has(trustee) || plannedAddressesLower.has(trustee)) {
        continue;
      }

      plannedAddressesLower.add(trustee);
      if (!planMap.has(baseGroup)) {
        planMap.set(baseGroup, []);
      }
      planMap.get(baseGroup)!.push(trustee);
    }
  }

  const plans = Array.from(planMap.entries()).map(([baseGroup, addresses]) => ({
    baseGroup,
    addresses
  }));

  if (plannedAddressesLower.size === 0) {
    logger.info("Router already trusts every human v2 CRC trusted by the current set of base groups.");
    return {
      baseGroupCount: baseGroups.length,
      routerTrustCount: routerTrustSet.size,
      humanTrustCount: humanV2Addresses.size,
      pendingTrustCount: 0,
      executedTrustCount: 0,
      dryRun,
      txHashes: [],
      plans
    };
  }

  logger.info(
    `Need to trust ${plannedAddressesLower.size} additional human v2 CRC(s) across ${plans.length} base group(s).`
  );

  const txHashes: string[] = [];
  let executedTrustCount = 0;

  for (const {baseGroup, addresses} of plans) {
    if (dryRun) {
      logger.info(
        `[DRY-RUN][${baseGroup}] Addresses to enable for routing: ${addresses.join(", ")}`
      );
    }

    const batches = chunkArray(addresses, enableBatchSize);
    if (batches.length === 0) {
      continue;
    }

    logger.info(
      `[${baseGroup}] Preparing ${batches.length} enableCRCForRouting batch(es) for ${addresses.length} address(es).`
    );

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const invalidBatchAddresses = batch.filter((address) => !humanV2Addresses.has(address));
      if (invalidBatchAddresses.length > 0) {
        logger.warn(
          `[${baseGroup}] Skipping enableCRCForRouting batch ${batchIndex + 1}/${batches.length}; ` +
            "batch contains non-human or non-v2 address(es): " +
            invalidBatchAddresses.join(", ")
        );
        continue;
      }

      if (dryRun || !routerService) {
        logger.info(
          `[DRY-RUN][${baseGroup}] Would call enableCRCForRouting with ${batch.length} address(es) (batch ${batchIndex + 1}/${batches.length}).`
        );
        continue;
      }

      const txHash = await routerService.enableCRCForRouting(baseGroup, batch);
      txHashes.push(txHash);
      executedTrustCount += batch.length;
      batch.forEach((address) => routerTrustSet.add(address));
      logger.info(
        `[${baseGroup}] enableCRCForRouting tx=${txHash} (batch ${batchIndex + 1}/${batches.length}) for ${batch.length} address(es).`
      );
    }
  }

  return {
    baseGroupCount: baseGroups.length,
    routerTrustCount: routerTrustSet.size,
    humanTrustCount: humanV2Addresses.size,
    pendingTrustCount: plannedAddressesLower.size,
    executedTrustCount: dryRun ? 0 : executedTrustCount,
    dryRun,
    txHashes,
    plans
  };
}

async function fetchAllBaseGroups(
  circlesRpc: ICirclesRpc,
  pageSize: number,
  logger: ILoggerService
): Promise<string[]> {
  const baseGroupAddresses = await circlesRpc.fetchAllBaseGroups(pageSize);
  const normalized = normalizeAddressArray(baseGroupAddresses);

  if (normalized.length === 0) {
    logger.warn("Base group query returned zero rows.");
  }

  return normalized;
}

async function collectBaseGroupTrusts(
  baseGroups: string[],
  circlesRpc: ICirclesRpc,
  logger: ILoggerService
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();

  for (const baseGroup of baseGroups) {
    logger.debug(`[${baseGroup}] Fetching outgoing trusts...`);
    const trusteesRaw = await circlesRpc.fetchAllTrustees(baseGroup);
    const normalized = normalizeAddressArray(trusteesRaw);
    map.set(baseGroup, normalized);
    logger.debug(`[${baseGroup}] Found ${normalized.length} trustee address(es).`);
  }

  return map;
}

async function filterHumanV2Addresses(
  dataClient: CirclesData,
  addresses: string[],
  batchSize: number,
  logger: ILoggerService
): Promise<Set<string>> {
  const humans = new Set<string>();
  const unique = normalizeAddressArray(addresses);
  if (unique.length === 0) {
    return humans;
  }

  const batches = chunkArray(unique, batchSize);
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    logger.debug(`Fetching avatar info batch ${batchIndex + 1}/${batches.length} (${batch.length} address(es)).`);
    const typedAddresses = batch.map((address) => getAddress(address)) as Address[];
    const infos = await dataClient.getAvatarInfoBatch(typedAddresses);
    for (const info of infos) {
      if (!info.isHuman || info.version !== 2) {
        continue;
      }
      const normalized = normalizeAddress(info.avatar);
      if (normalized) {
        humans.add(normalized);
      }
    }
  }

  return humans;
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    return [values];
  }

  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function normalizeAddress(address: string | undefined | null): string | undefined {
  if (!address || typeof address !== "string") {
    return undefined;
  }

  try {
    return getAddress(address).toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeAddressArray(addresses: string[]): string[] {
  const unique = new Set<string>();
  for (const value of addresses) {
    const normalized = normalizeAddress(value);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}
