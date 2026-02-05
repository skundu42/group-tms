import {IAvatarSafeMappingStore} from "../interfaces/IAvatarSafeMappingStore";

export class InMemoryAvatarSafeMappingStore implements IAvatarSafeMappingStore {
  private mapping = new Map<string, string>();
  private conflictHistory = new Map<string, string[]>();

  async load(): Promise<Map<string, string>> {
    return new Map(this.mapping);
  }

  async save(mapping: Map<string, string>): Promise<void> {
    this.mapping = new Map(mapping);
  }

  async loadConflictHistory(): Promise<Map<string, string[]>> {
    return new Map(
      Array.from(this.conflictHistory.entries()).map(([k, v]) => [k, [...v]])
    );
  }

  async saveConflictHistory(history: Map<string, string[]>): Promise<void> {
    this.conflictHistory = new Map(
      Array.from(history.entries()).map(([k, v]) => [k, [...v]])
    );
  }
}
