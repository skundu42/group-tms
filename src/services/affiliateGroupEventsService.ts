import { Interface, JsonRpcProvider } from "ethers";
import {
  AffiliateGroupChanged,
  IAffiliateGroupEventsService,
} from "../interfaces/IAffiliateGroupEventsService";

const ABI = [
  "event AffiliateGroupChanged(address indexed human, address oldGroup, address newGroup)",
];

export class AffiliateGroupEventsService implements IAffiliateGroupEventsService {
  private readonly provider: JsonRpcProvider;
  private readonly iface = new Interface(ABI);
  private readonly topic = this.iface.getEvent("AffiliateGroupChanged")!.topicHash;

  private readonly chunkSize: number = 10000;
  private readonly maxRetries: number = 3;
  private readonly retryDelayMs: number = 1000;

  constructor(rpcUrl: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  async fetchAffiliateGroupChanged(
    registryAddress: string,
    targetGroup: string,
    fromBlock: number,
    toBlock?: number
  ): Promise<AffiliateGroupChanged[]> {
    const latest = toBlock ?? (await this.provider.getBlockNumber());
    const allLogs: any[] = [];

    let start = fromBlock;
    while (start <= latest) {
      const end = Math.min(latest, start + this.chunkSize - 1);
      let attempt = 0;
      // retry loop for transient RPC timeouts
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const chunkLogs = await this.provider.getLogs({
            address: registryAddress,
            fromBlock: start,
            toBlock: end,
            topics: [this.topic],
          });
          allLogs.push(...chunkLogs);
          break;
        } catch (err: any) {
          const msg = String(err?.message || err);
          const code = (err && (err.code ?? err.error?.code)) as any;
          const isTimeout =
            code === -32016 ||
            msg.includes("timeout") ||
            msg.includes("canceled") ||
            msg.includes("cancelled");
          if (!isTimeout || attempt >= this.maxRetries) {
            throw err;
          }
          attempt++;
          if (this.retryDelayMs > 0) {
            await new Promise((res) => setTimeout(res, this.retryDelayMs));
          }
        }
      }
      start = end + 1;
    }

    const targetLc = targetGroup.toLowerCase();

    const events: AffiliateGroupChanged[] = allLogs
      .map((l) => {
        const decoded = this.iface.decodeEventLog(
          "AffiliateGroupChanged",
          l.data,
          l.topics
        ) as unknown as { human: string; oldGroup: string; newGroup: string };

        const human = String(decoded.human);
        const oldGroup = String(decoded.oldGroup);
        const newGroup = String(decoded.newGroup);

        return {
          blockNumber: l.blockNumber!,
          txHash: l.transactionHash!,
          human,
          oldGroup,
          newGroup,
        } satisfies AffiliateGroupChanged;
      })
      .filter(
        (e) =>
          e.oldGroup.toLowerCase() === targetLc ||
          e.newGroup.toLowerCase() === targetLc
      );

    return events;
  }
}
