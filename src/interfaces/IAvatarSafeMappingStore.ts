export interface IAvatarSafeMappingStore {
  /**
   * Loads the previously persisted avatar → safe mapping.
   * Returns an empty map when no prior state exists.
   * Keys are checksum avatar addresses, values are checksum safe addresses.
   */
  load(): Promise<Map<string, string>>;

  /**
   * Atomically persists the avatar → safe mapping, fully replacing
   * the previous state.
   */
  save(mapping: Map<string, string>): Promise<void>;
}
