import {IAvatarSafeMappingStore} from "../interfaces/IAvatarSafeMappingStore";

export class InMemoryAvatarSafeMappingStore implements IAvatarSafeMappingStore {
  private mapping = new Map<string, string>();

  async load(): Promise<Map<string, string>> {
    return new Map(this.mapping);
  }

  async save(mapping: Map<string, string>): Promise<void> {
    this.mapping = new Map(mapping);
  }
}
