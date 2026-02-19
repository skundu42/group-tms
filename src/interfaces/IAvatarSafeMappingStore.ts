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

  /**
   * Loads the stored conflict history: safe → all known claimant avatars
   * ever observed across all previous runs.
   * Returns an empty map when no prior state exists.
   */
  loadConflictHistory(): Promise<Map<string, string[]>>;

  /**
   * Persists the conflict history, fully replacing the previous state.
   */
  saveConflictHistory(history: Map<string, string[]>): Promise<void>;
}
