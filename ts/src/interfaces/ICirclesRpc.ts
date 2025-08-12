import {CrcV2_CirclesBackingCompleted, CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";
import {CrcV2_Trust} from "@circles-sdk/data";

/**
 * Provides access to Circles events.
 */
export interface ICirclesRpc {
    /**
     * Fetches all BackingInitiated events from the Circles contract between the specified blocks.
     * @param fromBlock The block number to start fetching events from.
     * @param toBlock Optional block number to end fetching events at. If not provided, fetches until the latest block.
     */
    fetchBackingInitiatedEvents(fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingInitiated[]>;

    /**
     * Fetches all BackingCompleted events from the Circles contract between the specified blocks.
     * @param fromBlock The block number to start fetching events from.
     * @param toBlock Optional block number to end fetching events at. If not provided, fetches until the latest block.
     */
    fetchBackingCompletedEvents(fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingCompleted[]>;

    /**
     * Fetches all Trust events for a specific truster between the specified blocks.
     * @param truster The address of the truster to fetch events for.
     * @param fromBlock The block number to start fetching events from.
     * @param toBlock Optional block number to end fetching events at. If not provided, fetches until the latest block.
     */
    fetchTrustEvents(truster: string, fromBlock: number, toBlock?: number): Promise<CrcV2_Trust[]>;

    /**
     * Fetches all trustees for a given truster.
     * @param truster The address of the truster to fetch trustees for.
     * @returns A promise that resolves to an array of trustee addresses.
     */
    fetchAllTrustees(truster: string): Promise<string[]>;
}