export type AffiliateGroupChanged = {
  blockNumber: number;
  txHash: string;
  human: string;
  oldGroup: string;
  newGroup: string;
};

/**
 * Provides access to AffiliateGroupChanged events from a Registry contract.
 */
export interface IAffiliateGroupEventsService {
  /**
   * Fetches AffiliateGroupChanged events for a given registry and filters by a target group
   * (matching either oldGroup or newGroup).
   * @param registryAddress The address of the Registry emitting the events.
   * @param targetGroup The group address to match against oldGroup or newGroup.
   * @param fromBlock The starting block number (inclusive).
   * @param toBlock Optional ending block number (inclusive). If omitted, queries to latest.
   */
  fetchAffiliateGroupChanged(
    registryAddress: string,
    targetGroup: string,
    fromBlock: number,
    toBlock?: number
  ): Promise<AffiliateGroupChanged[]>;
}

