import {Contract, getAddress, JsonRpcProvider, Wallet} from "ethers";
import {IRouterService} from "../interfaces/IRouterService";

const ROUTER_ABI = [
  "function enableCRCForRouting(address baseGroup, address[] crcArray)"
];

export class RouterService implements IRouterService {
  private readonly provider: JsonRpcProvider;
  private readonly wallet: Wallet;
  private readonly contract: Contract;

  constructor(rpcUrl: string, routerAddress: string, servicePrivateKey: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.wallet = new Wallet(servicePrivateKey, this.provider);
    this.contract = new Contract(getAddress(routerAddress), ROUTER_ABI, this.wallet);
  }

  async enableCRCForRouting(baseGroup: string, crcAddresses: string[]): Promise<string> {
    if (crcAddresses.length === 0) {
      throw new Error("enableCRCForRouting requires at least one CRC address.");
    }

    const normalizedBaseGroup = getAddress(baseGroup);
    const normalizedCrcs = crcAddresses.map((address) => getAddress(address));

    const tx = await this.contract.enableCRCForRouting(normalizedBaseGroup, normalizedCrcs);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error(`enableCRCForRouting failed: ${tx.hash}`);
    }

    return tx.hash;
  }
}

