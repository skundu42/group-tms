import {
  CrcV2_CirclesBackingCompleted,
  CrcV2_CirclesBackingInitiated
} from "@circles-sdk/data/dist/events/events";
import {AffiliateGroupChanged} from "../src/interfaces/IAffiliateGroupEventsService";

let counter = 1;

export function mkCompleted(params?: Partial<CrcV2_CirclesBackingCompleted>): CrcV2_CirclesBackingCompleted {
  const i = counter++;
  return {
    $event: "CrcV2_CirclesBackingCompleted",
    backer: params?.backer ?? `0xbacker${i}`.padEnd(42, "0"),
    circlesBackingInstance: params?.circlesBackingInstance ?? `0xinst${i}`.padEnd(42, "1"),
    blockNumber: params?.blockNumber ?? (1000 + i),
    transactionHash: params?.transactionHash ?? `0xhashc${i}`,
    timestamp: params?.timestamp ?? (9_000 + i),
  } as CrcV2_CirclesBackingCompleted;
}

export function mkInitiated(params?: Partial<CrcV2_CirclesBackingInitiated>): CrcV2_CirclesBackingInitiated {
  const i = counter++;
  return {
    $event: "CrcV2_CirclesBackingInitiated",
    backer: params?.backer ?? `0xbacker${i}`.padEnd(42, "0"),
    circlesBackingInstance: params?.circlesBackingInstance ?? `0xinst${i}`.padEnd(42, "1"),
    blockNumber: params?.blockNumber ?? (1000 + i),
    transactionHash: params?.transactionHash ?? `0xhishi${i}`,
    timestamp: params?.timestamp, // undefined is meaningful in some tests
  } as unknown as CrcV2_CirclesBackingInitiated;
}

// Affiliate registry event factories (for OIC tests)
export function mkAffChange(params?: Partial<AffiliateGroupChanged>): AffiliateGroupChanged {
  const i = counter++;
  return {
    blockNumber: params?.blockNumber ?? (1000 + i),
    txHash: params?.txHash ?? `0xaff${i}`,
    human: params?.human ?? `0xhuman${i}`.padEnd(42, "0"),
    oldGroup: params?.oldGroup ?? "0x0",
    newGroup: params?.newGroup ?? `0xgrp${i}`.padEnd(42, "0"),
  } as AffiliateGroupChanged;
}

export function mkAffJoin(human: string, group: string, params?: Partial<AffiliateGroupChanged>): AffiliateGroupChanged {
  return mkAffChange({
    human,
    oldGroup: params?.oldGroup ?? "0x0",
    newGroup: params?.newGroup ?? group,
    blockNumber: params?.blockNumber,
    txHash: params?.txHash,
  });
}

export function mkAffLeave(human: string, group: string, params?: Partial<AffiliateGroupChanged>): AffiliateGroupChanged {
  return mkAffChange({
    human,
    oldGroup: params?.oldGroup ?? group,
    newGroup: params?.newGroup ?? "0x0",
    blockNumber: params?.blockNumber,
    txHash: params?.txHash,
  });
}
