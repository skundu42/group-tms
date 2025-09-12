import {GroupOwnerAndServiceAddress, IGroupService} from "../interfaces/IGroupService";
import {Contract, getAddress, JsonRpcProvider, Wallet} from "ethers";

const GROUP_MINI_ABI = [
  "function owner() view returns (address)",
  "function service() view returns (address)",
  "function trustBatchWithConditions(address[] memory _members, uint96 _expiry)"
];

export class GroupService implements IGroupService {
  constructor(private readonly rpcUrl: string, private readonly servicePrivateKey: string) {
  }

  /**
   * Calls the `trustBatchWithConditions` function of the group contract and returns the transaction hash.
   * @param groupAddress
   * @param trusteeAddresses
   * @returns The transaction hash of the trustBatchWithConditions call.
   */
  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    const provider = new JsonRpcProvider(this.rpcUrl);
    const wallet = new Wallet(this.servicePrivateKey, provider);
    const group = new Contract(groupAddress, GROUP_MINI_ABI, wallet);

    // uint96 max
    const expiry: bigint = (1n << 96n) - 1n;

    const tx = await group.trustBatchWithConditions(trusteeAddresses, expiry);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error(`trustBatchWithConditions failed: ${tx.hash}`);
    }

    return tx.hash;
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {

    const provider = new JsonRpcProvider(this.rpcUrl);
    const wallet = new Wallet(this.servicePrivateKey, provider);
    const group = new Contract(groupAddress, GROUP_MINI_ABI, wallet);

    const tx = await group.trustBatchWithConditions(trusteeAddresses, 0n);
    const receipt = await tx.wait();

    if (!receipt || receipt.status !== 1) {
      throw new Error(`untrustBatch failed: ${tx.hash}`);
    }

    return tx.hash;
  }

  async fetchGroupOwnerAndService(groupAddress: string): Promise<GroupOwnerAndServiceAddress> {
    const provider = new JsonRpcProvider(this.rpcUrl);
    const group = new Contract(groupAddress, GROUP_MINI_ABI, provider);

    const owner = String(await group.owner());
    const service = String(await group.service());

    const ownerC = getAddress(owner).toLowerCase();
    const serviceC = getAddress(service).toLowerCase();

    return {
      owner: ownerC,
      service: serviceC
    };
  }
}
