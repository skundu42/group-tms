import {CrcV2_CirclesBackingCompleted, CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";
import {CrcV2_Trust} from "@circles-sdk/data";
import {getAddress} from "ethers";
import {ICirclesRpc} from "../src/interfaces/ICirclesRpc";
import {IChainRpc} from "../src/interfaces/IChainRpc";
import {IBlacklistingService, IBlacklistServiceVerdict} from "../src/interfaces/IBlacklistingService";
import {IGroupService} from "../src/interfaces/IGroupService";
import {
  CreateLBPResult,
  IBackingInstanceService,
  ResetCowSwapOrderResult
} from "../src/interfaces/IBackingInstanceService";
import {ISlackService} from "../src/interfaces/ISlackService";
import {ILoggerService} from "../src/interfaces/ILoggerService";
import {AffiliateGroupChanged, IAffiliateGroupEventsService} from "../src/interfaces/IAffiliateGroupEventsService";
import {type AvatarSafeResult, IAvatarSafeService} from "../src/interfaces/IAvatarSafeService";
import {IRouterService} from "../src/interfaces/IRouterService";
import {IRouterEnablementStore} from "../src/interfaces/IRouterEnablementStore";
import {IAvatarSafeMappingStore} from "../src/interfaces/IAvatarSafeMappingStore";

export class FakeLogger implements ILoggerService {
  logs: { level: "info" | "warn" | "error" | "debug" | "table"; args: unknown[] }[] = [];

  constructor(private readonly verbose: boolean = true) {
  }

  private push(level: any, ...args: unknown[]) {
    if (level === "debug" || level === "table") {
      if (!this.verbose) {
        return;
      }
    }
    this.logs.push({level, args});
  }

  info(...args: unknown[]): void {
    this.push("info", ...args);
  }

  warn(...args: unknown[]): void {
    this.push("warn", ...args);
  }

  error(...args: unknown[]): void {
    this.push("error", ...args);
  }

  debug(...args: unknown[]): void {
    this.push("debug", ...args);
  }

  table(data: any, columns?: readonly (string | number)[]): void {
    this.push("table", data, columns);
  }

  child(prefix: string): ILoggerService {
    return this;
  }
}

export class FakeCirclesRpc implements ICirclesRpc {
  initiated: CrcV2_CirclesBackingInitiated[] = [];
  completed: CrcV2_CirclesBackingCompleted[] = [];
  trusts: CrcV2_Trust[] = [];
  trusteesByTruster: Record<string, string[]> = {};
  baseGroups: string[] = [];
  humanityOverrides = new Map<string, boolean>();

  async fetchBackingInitiatedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingInitiated[]> {
    const upper = toBlock ?? Number.MAX_SAFE_INTEGER;
    return this.initiated.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= upper);
  }

  async fetchBackingCompletedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingCompleted[]> {
    const upper = toBlock ?? Number.MAX_SAFE_INTEGER;
    return this.completed.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= upper);
  }

  async fetchAllTrustees(truster: string): Promise<string[]> {
    return this.trusteesByTruster[truster.toLowerCase()] ?? [];
  }

  async fetchAllBaseGroups(_pageSize?: number): Promise<string[]> {
    return this.baseGroups;
  }

  async isHuman(address: string): Promise<boolean> {
    const normalized = address.toLowerCase();
    const override = this.humanityOverrides.get(normalized);
    if (override !== undefined) {
      return override;
    }

    if (this.baseGroups.some((group) => group.toLowerCase() === normalized)) {
      return false;
    }

    return true;
  }
}

export class FakeChainRpc implements IChainRpc {
  constructor(private readonly head: { blockNumber: number; timestamp: number }) {
  }

  async getHeadBlock(): Promise<{ blockNumber: number; timestamp: number }> {
    return this.head;
  }

  async getTransactionReceipt(txHash: string): Promise<any> {
    throw new Error("Not used in these tests");
  }
}

export class FakeBlacklist implements IBlacklistingService {
  private loaded: boolean = false;

  constructor(private readonly blocked: Set<string> = new Set(), private readonly flagged: Set<string> = new Set()) {
  }

  async loadBlacklist(): Promise<void> {
    this.loaded = true;
  }

  getBlacklistCount(): number {
    return this.blocked.size + this.flagged.size;
  }

  async checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]> {
    return addresses.map(a => {
      const lc = a.toLowerCase();
      if (this.blocked.has(lc)) {
        return {address: lc, is_bot: true, category: "blocked"};
      }
      if (this.flagged.has(lc)) {
        return {address: lc, is_bot: false, category: "flagged"};
      }
      return {address: lc, is_bot: false};
    });
  }
}

export class FakeGroupService implements IGroupService {
  calls: { type: "trust" | "untrust"; groupAddress: string; trusteeAddresses: string[] }[] = [];
  trustCalls = 0;
  untrustCalls = 0;

  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.trustCalls += 1;
    this.calls.push({type: "trust", groupAddress, trusteeAddresses: [...trusteeAddresses]});
    return `0xtrust_${this.trustCalls}`;
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    this.untrustCalls += 1;
    this.calls.push({type: "untrust", groupAddress, trusteeAddresses: [...trusteeAddresses]});
    return `0xuntrust_${this.untrustCalls}`;
  }

  async fetchGroupOwnerAndService(): Promise<any> {
    throw new Error("Not under test");
  }
}

export class FakeAvatarSafeService implements IAvatarSafeService {
  private readonly safeByAvatar: Map<string, string> | null;

  constructor(mapping: Record<string, string> | null = null) {
    if (mapping === null) {
      this.safeByAvatar = null;
      return;
    }

    this.safeByAvatar = new Map<string, string>();
    for (const [rawAvatar, safe] of Object.entries(mapping)) {
      try {
        const normalized = getAddress(rawAvatar);
        this.safeByAvatar.set(normalized, safe);
      } catch {
        // ignore invalid addresses provided in tests
      }
    }
  }

  async findAvatarsWithSafes(avatars: string[]): Promise<AvatarSafeResult> {
    const result = new Map<string, string>();
    for (const avatar of avatars) {
      try {
        const normalized = getAddress(avatar);
        if (this.safeByAvatar === null) {
          result.set(normalized, `0xsafe_${normalized.slice(2, 8).toLowerCase()}`);
          continue;
        }

        const configured = this.safeByAvatar.get(normalized);
        if (configured) {
          result.set(normalized, configured);
        }
      } catch {
        // ignore invalid avatar addresses passed in tests
      }
    }

    const safeConflicts = new Map<string, string[]>();
    const avatarsBySafe = new Map<string, string[]>();
    for (const [avatar, safe] of result.entries()) {
      const existing = avatarsBySafe.get(safe);
      if (existing) {
        existing.push(avatar);
      } else {
        avatarsBySafe.set(safe, [avatar]);
      }
    }
    for (const [safe, avatarsForSafe] of avatarsBySafe.entries()) {
      if (avatarsForSafe.length < 2) continue;
      safeConflicts.set(safe, avatarsForSafe);
      for (const avatar of avatarsForSafe) {
        result.delete(avatar);
      }
    }

    return {mappings: result, safeConflicts};
  }
}

export class FakeBackingInstanceService implements IBackingInstanceService {
  simulateReset: Record<string, ResetCowSwapOrderResult> = {};
  simulateCreate: Record<string, CreateLBPResult> = {};
  resetCalls: string[] = [];
  createCalls: string[] = [];

  async simulateResetCowSwapOrder(addr: string): Promise<ResetCowSwapOrderResult> {
    return this.simulateReset[addr.toLowerCase()];
  }

  async simulateCreateLbp(addr: string): Promise<CreateLBPResult> {
    return this.simulateCreate[addr.toLowerCase()];
  }

  async resetCowSwapOrder(addr: string): Promise<string> {
    this.resetCalls.push(addr.toLowerCase());
    return `0xreset_${addr.toLowerCase()}`;
  }

  async createLbp(addr: string): Promise<string> {
    this.createCalls.push(addr.toLowerCase());
    return `0xcreate_${addr.toLowerCase()}`;
  }
}

export class FakeSlack implements ISlackService {
  notifications: { event: CrcV2_CirclesBackingInitiated; reason: string }[] = [];
  generalNotifications: string[] = [];

  async notifyBackingNotCompleted(backingInitiatedEvent: CrcV2_CirclesBackingInitiated, reason: string): Promise<void> {
    this.notifications.push({event: backingInitiatedEvent, reason});
  }

  async notifySlackStartOrCrash(message: string): Promise<void> {
    this.generalNotifications.push(message);
  }
}

export class FakeAffiliateGroupEvents implements IAffiliateGroupEventsService {
  events: AffiliateGroupChanged[] = [];

  async fetchAffiliateGroupChanged(
    registryAddress: string,
    targetGroup: string,
    fromBlock: number,
    toBlock?: number
  ): Promise<AffiliateGroupChanged[]> {
    const upper = toBlock ?? Number.MAX_SAFE_INTEGER;
    const g = targetGroup.toLowerCase();
    return this.events.filter(
      (e) => e.blockNumber >= fromBlock && e.blockNumber <= upper &&
        (e.oldGroup.toLowerCase() === g || e.newGroup.toLowerCase() === g)
    );
  }
}

export class FakeRouterService implements IRouterService {
  calls: { baseGroup: string; crcAddresses: string[] }[] = [];
  txHashes: string[] = [];
  private readonly responseQueue: string[];
  failWith?: Error;

  constructor(txHashResponses: string[] = []) {
    this.responseQueue = [...txHashResponses];
  }

  async enableCRCForRouting(baseGroup: string, crcAddresses: string[]): Promise<string> {
    this.calls.push({baseGroup, crcAddresses: [...crcAddresses]});
    if (this.failWith) {
      throw this.failWith;
    }

    const txHash = this.responseQueue.length > 0
      ? this.responseQueue.shift()!
      : `0xtx_${this.calls.length}`;
    this.txHashes.push(txHash);
    return txHash;
  }
}

export class FakeRouterEnablementStore implements IRouterEnablementStore {
  private readonly enabled = new Set<string>();

  constructor(initial?: string[]) {
    if (initial) {
      initial.forEach((address) => this.enabled.add(address.toLowerCase()));
    }
  }

  async loadEnabledAddresses(): Promise<string[]> {
    return Array.from(this.enabled);
  }

  async markEnabled(addresses: string[]): Promise<void> {
    for (const address of addresses) {
      this.enabled.add(address.toLowerCase());
    }
  }
}

export class FakeAvatarSafeMappingStore implements IAvatarSafeMappingStore {
  private mapping: Map<string, string>;
  saveCalls = 0;

  constructor(initial?: Record<string, string>) {
    this.mapping = new Map<string, string>();
    if (initial) {
      for (const [avatar, safe] of Object.entries(initial)) {
        try {
          this.mapping.set(getAddress(avatar), safe);
        } catch {
          // ignore invalid addresses in tests
        }
      }
    }
  }

  async load(): Promise<Map<string, string>> {
    return new Map(this.mapping);
  }

  async save(mapping: Map<string, string>): Promise<void> {
    this.saveCalls += 1;
    this.mapping = new Map(mapping);
  }

  getSavedMapping(): Map<string, string> {
    return new Map(this.mapping);
  }
}
