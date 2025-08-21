import {
  CrcV2_CirclesBackingCompleted,
  CrcV2_CirclesBackingInitiated
} from "@circles-sdk/data/dist/events/events";

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
