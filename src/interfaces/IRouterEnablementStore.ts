export interface IRouterEnablementStore {
  /**
   * Returns every avatar address that has already been enabled for routing.
   */
  loadEnabledAddresses(): Promise<string[]>;

  /**
   * Records the provided avatar addresses as having been enabled for routing.
   */
  markEnabled(addresses: string[]): Promise<void>;
}

