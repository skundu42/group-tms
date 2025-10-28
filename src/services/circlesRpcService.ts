import {CirclesData, CirclesRpc} from "@circles-sdk/data";
import {Address} from "@circles-sdk/utils";
import {CrcV2_CirclesBackingCompleted, CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";
import {ICirclesRpc} from "../interfaces/ICirclesRpc";

export class CirclesRpcService implements ICirclesRpc {
  constructor(private rpcUrl: string) {
  }

  async fetchAllTrustees(truster: string): Promise<string[]> {
    const trusterLc = truster.toLowerCase();
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    const trustRelationsQuery = data.getTrustRelations(truster as Address, 1000);
    const allTrustees: string[] = [];

    while (await trustRelationsQuery.queryNextPage()) {
      trustRelationsQuery
        .currentPage?.results
        .filter(o => o.truster.toLowerCase() === trusterLc)
        .map(o => o.trustee.toLowerCase())
        .forEach(o => allTrustees.push(o))
    }

    return allTrustees;
  }

  async fetchBackingCompletedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingCompleted[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    return (await data.getEvents(undefined, fromBlock, toBlock, ["CrcV2_CirclesBackingCompleted"], [{
      Type: "FilterPredicate",
      FilterType: "Equals",
      Column: "emitter",
      Value: backingFactoryAddress
    }])) as CrcV2_CirclesBackingCompleted[];
  }

  async fetchBackingInitiatedEvents(backingFactoryAddress: string, fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingInitiated[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    return (await data.getEvents(undefined, fromBlock, toBlock, ["CrcV2_CirclesBackingInitiated"], [{
      Type: "FilterPredicate",
      FilterType: "Equals",
      Column: "emitter",
      Value: backingFactoryAddress
    }])) as CrcV2_CirclesBackingInitiated[];
  }

  async fetchAllBaseGroups(pageSize: number = 1000): Promise<string[]> {
    const limit = Math.max(1, pageSize);
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    const query = data.findGroups(limit, {
      groupTypeIn: ["CrcV2_BaseGroupCreated"]
    });

    const groups = new Set<string>();

    while (await query.queryNextPage()) {
      const rows = query.currentPage?.results ?? [];
      for (const row of rows) {
        if (typeof row.group === "string" && row.group.length > 0) {
          groups.add(row.group);
        }
      }
    }

    return Array.from(groups);
  }
}
