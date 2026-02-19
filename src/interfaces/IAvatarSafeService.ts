export type AvatarSafeResult = {
  /** Clean 1:1 avatar → safe mappings (no conflicts). */
  mappings: Map<string, string>;
  /** Safes that have multiple avatar claimants: safe → avatars[]. */
  safeConflicts: Map<string, string[]>;
};

export interface IAvatarSafeService {
  /**
   * Returns avatar → safe mappings together with conflict information.
   *
   * Clean 1:1 pairs go into `mappings`. Avatars linked to more than one
   * safe module are omitted from `mappings`. Safes linked to more than
   * one avatar are omitted from `mappings` and reported in `safeConflicts`.
   */
  findAvatarsWithSafes(avatars: string[]): Promise<AvatarSafeResult>;
}
