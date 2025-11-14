import {getAddress} from "ethers";

import {IRouterEnablementStore} from "../../interfaces/IRouterEnablementStore";

function normalize(address: string): string {
  return getAddress(address).toLowerCase();
}

export class InMemoryRouterEnablementStore implements IRouterEnablementStore {
  private readonly enabled = new Set<string>();

  constructor(initialAddresses: string[] = []) {
    this.addAddresses(initialAddresses);
  }

  async loadEnabledAddresses(): Promise<string[]> {
    return Array.from(this.enabled);
  }

  async markEnabled(addresses: string[]): Promise<void> {
    this.addAddresses(addresses);
  }

  private addAddresses(addresses: string[]): void {
    for (const address of addresses) {
      try {
        this.enabled.add(normalize(address));
      } catch {
        // Ignore invalid addresses provided by callers.
      }
    }
  }
}
