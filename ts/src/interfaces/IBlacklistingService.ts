/**
 * Defines a service for checking if addresses are blacklisted.
 */
export interface IBlacklistingService {
    /**
     * Checks if the given addresses are blacklisted.
     * @param addresses The list of addresses to check.
     * @return A promise that resolves to an array of verdicts, each indicating whether the address is a bot and optionally providing a category and reason.
     */
    checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]>
}

/**
 * A single verdict from the blacklisting service.
 */
export interface IBlacklistServiceVerdict {
    address: string;
    is_bot: boolean;
    category?: string;
    reason?: string;
}