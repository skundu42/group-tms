export interface IAvatarSafeService {
  /**
   * Returns a map of avatars that have a configured safe address.
   * The key is the normalized avatar address (lowercase checksum),
   * and the value is the normalized safe address.
   */
  findAvatarsWithSafes(avatars: string[]): Promise<Map<string, string>>;
}
