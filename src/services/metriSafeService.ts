import {getAddress} from "ethers";
import {IAvatarSafeService} from "../interfaces/IAvatarSafeService";

type DelayModuleOwner = {
  ownerAddress?: string | null;
};

type DelayModule = {
  safeAddress?: string | null;
  owners?: DelayModuleOwner[] | null;
};

type GraphqlResponse = {
  data?: {
    Metri_Pay_DelayModule?: DelayModule[] | null;
  } | null;
  errors?: Array<{message?: string}> | null;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK_SIZE = 2500;

const QUERY = `query($addresses:[String!]!){
  Metri_Pay_DelayModule(where:{owners:{ownerAddress:{_in:$addresses}}}){
    safeAddress
    owners(where:{ownerAddress:{_in:$addresses}}){
      ownerAddress
    }
  }
}`;

export class MetriSafeService implements IAvatarSafeService {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly chunkSize: number = DEFAULT_CHUNK_SIZE
  ) {
    if (!endpoint || endpoint.trim().length === 0) {
      throw new Error("MetriSafeService requires a non-empty endpoint");
    }
  }

  async findAvatarsWithSafes(avatars: string[]): Promise<Map<string, string>> {
    const normalized = normalizeAddresses(avatars);
    if (normalized.length === 0) {
      return new Map();
    }

    const requested = new Set(normalized);
    const result = new Map<string, string>();
    const conflicts = new Set<string>();

    for (let index = 0; index < normalized.length; index += this.chunkSize) {
      const chunk = normalized.slice(index, index + this.chunkSize);
      const modules = await this.fetchModules(chunk);
      this.mergeModules(result, requested, modules, conflicts);
    }

    for (const conflictedAvatar of conflicts) {
      result.delete(conflictedAvatar);
    }

    return result;
  }

  private async fetchModules(addresses: string[]): Promise<DelayModule[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json"
      };
      if (this.apiKey && this.apiKey.trim().length > 0) {
        headers["x-api-key"] = this.apiKey.trim();
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: QUERY,
          variables: {addresses}
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`MetriSafeService request failed: HTTP ${response.status} ${response.statusText}`);
      }

      const payload = await response.json() as GraphqlResponse;
      if (payload.errors && payload.errors.length > 0) {
        const messages = payload.errors
          .map((e) => e?.message)
          .filter((m): m is string => typeof m === "string" && m.length > 0);
        throw new Error(`MetriSafeService GraphQL error: ${messages.join(", ")}`);
      }

      const modules = payload.data?.Metri_Pay_DelayModule;
      if (!Array.isArray(modules)) {
        return [];
      }

      return modules;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("MetriSafeService request timed out");
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private mergeModules(
    accumulator: Map<string, string>,
    requested: Set<string>,
    modules: DelayModule[],
    conflicts: Set<string>
  ): void {
    for (const module of modules) {
      const safe = normalizeAddress(module.safeAddress);
      if (!safe) {
        continue;
      }

      const owners = Array.isArray(module.owners) ? module.owners : [];
      for (const owner of owners) {
        const avatar = normalizeAddress(owner.ownerAddress);
        if (!avatar) {
          continue;
        }
        if (!requested.has(avatar)) {
          continue;
        }

        if (conflicts.has(avatar)) {
          continue;
        }

        if (accumulator.has(avatar)) {
          accumulator.delete(avatar);
          conflicts.add(avatar);
          continue;
        }

        if (!accumulator.has(avatar)) {
          accumulator.set(avatar, safe);
        }
      }
    }
  }
}

function normalizeAddresses(addresses: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of addresses) {
    const normalizedAddress = normalizeAddress(value);
    if (!normalizedAddress) {
      continue;
    }
    if (seen.has(normalizedAddress)) {
      continue;
    }
    seen.add(normalizedAddress);
    normalized.push(normalizedAddress);
  }
  return normalized;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

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
