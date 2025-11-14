import {promises as fs} from "fs";
import path from "path";
import {getAddress} from "ethers";

import {IRouterEnablementStore} from "../../interfaces/IRouterEnablementStore";

function normalize(address: string): string {
  return getAddress(address).toLowerCase();
}

export class FileRouterEnablementStore implements IRouterEnablementStore {
  private cache: Set<string> | null = null;

  constructor(private readonly filePath: string) {}

  async loadEnabledAddresses(): Promise<string[]> {
    await this.ensureCache();
    return Array.from(this.cache!);
  }

  async markEnabled(addresses: string[]): Promise<void> {
    if (addresses.length === 0) {
      return;
    }

    await this.ensureCache();
    let changed = false;
    for (const address of addresses) {
      try {
        const normalized = normalize(address);
        if (!this.cache!.has(normalized)) {
          this.cache!.add(normalized);
          changed = true;
        }
      } catch {
        // Ignore invalid addresses provided by callers.
      }
    }

    if (changed) {
      await this.persist();
    }
  }

  private async ensureCache(): Promise<void> {
    if (this.cache) {
      return;
    }

    try {
      const contents = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) {
        this.cache = new Set();
        return;
      }

      const normalized = parsed.flatMap((value) => {
        if (typeof value !== "string") {
          return [];
        }

        try {
          return [normalize(value)];
        } catch {
          return [];
        }
      });

      this.cache = new Set(normalized);
    } catch (error: any) {
      if (error && error.code === "ENOENT") {
        this.cache = new Set();
        return;
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), {recursive: true});
    await fs.writeFile(this.filePath, JSON.stringify(Array.from(this.cache!), null, 2), "utf8");
  }
}

