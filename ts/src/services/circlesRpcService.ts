import {CirclesData, CirclesRpc, CrcV2_Trust} from "@circles-sdk/data";
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
        .filter(o => o.truster === trusterLc)
        .map(o => o.trustee)
        .forEach(o => allTrustees.push(o))
    }

    return allTrustees;
  }

  async fetchBackingCompletedEvents(fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingCompleted[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    return (await data.getEvents(undefined, fromBlock, toBlock, ["CrcV2_CirclesBackingCompleted"])) as CrcV2_CirclesBackingCompleted[];
  }

  async fetchBackingInitiatedEvents(fromBlock: number, toBlock?: number): Promise<CrcV2_CirclesBackingInitiated[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    return (await data.getEvents(undefined, fromBlock, toBlock, ["CrcV2_CirclesBackingInitiated"])) as CrcV2_CirclesBackingInitiated[];
  }

  async fetchTrustEvents(truster: string, fromBlock: number, toBlock?: number): Promise<CrcV2_Trust[]> {
    const rpc = new CirclesRpc(this.rpcUrl);
    const data = new CirclesData(rpc);
    return (await data.getEvents(undefined, fromBlock, toBlock, ["CrcV2_Trust"], [{
      Column: "truster",
      Type: "FilterPredicate",
      FilterType: "Equals",
      Value: truster.toLowerCase()
    }])) as CrcV2_Trust[];
  }
}