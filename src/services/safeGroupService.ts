import Safe from "@safe-global/protocol-kit";
import {Contract, Interface, JsonRpcProvider, getAddress} from "ethers";
import {GroupOwnerAndServiceAddress, IGroupService} from "../interfaces/IGroupService";
import {GROUP_MINI_ABI} from "./groupService";

const GROUP_INTERFACE = new Interface(GROUP_MINI_ABI);
const MAX_UINT96 = (1n << 96n) - 1n;

function ensureSuccessfulReceipt(receipt: any, context: string) {
  if (!receipt) throw new Error(`${context} did not return a receipt`);
  if (receipt.status !== 1 && receipt.status !== 1n && receipt.status !== "0x1") {
    throw new Error(`${context} failed on-chain (status ${String(receipt.status)})`);
  }
  return receipt;
}

export class SafeGroupService implements IGroupService {
  private readonly provider: JsonRpcProvider;
  private readonly safePromise: Promise<Safe>;
  private readonly safeAddress: string;

  constructor(rpcUrl: string, signerPrivateKey: string, safeAddress: string) {
    if (!signerPrivateKey || signerPrivateKey.trim().length === 0) {
      throw new Error("Safe signer private key is required");
    }
    if (!safeAddress || safeAddress.trim().length === 0) {
      throw new Error("Safe address is required");
    }

    this.provider = new JsonRpcProvider(rpcUrl);
    this.safeAddress = getAddress(safeAddress);
    this.safePromise = Safe.init({
      provider: rpcUrl,
      signer: signerPrivateKey,
      safeAddress: this.safeAddress
    });
  }

  async trustBatchWithConditions(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    const data = GROUP_INTERFACE.encodeFunctionData("trustBatchWithConditions", [
      trusteeAddresses,
      MAX_UINT96
    ]);

    return this.executeSafeTransaction(groupAddress, data);
  }

  async untrustBatch(groupAddress: string, trusteeAddresses: string[]): Promise<string> {
    const data = GROUP_INTERFACE.encodeFunctionData("trustBatchWithConditions", [
      trusteeAddresses,
      0n
    ]);

    return this.executeSafeTransaction(groupAddress, data);
  }

  async fetchGroupOwnerAndService(groupAddress: string): Promise<GroupOwnerAndServiceAddress> {
    const group = new Contract(groupAddress, GROUP_MINI_ABI, this.provider);

    const owner = String(await group.owner());
    const service = String(await group.service());

    return {
      owner: getAddress(owner).toLowerCase(),
      service: getAddress(service).toLowerCase()
    };
  }

  private async executeSafeTransaction(
    groupAddress: string,
    data: string,
    confirmationsToWait = 1
  ): Promise<string> {
    const safe = await this.safePromise;
    const to = getAddress(groupAddress);

    const safeTx = await safe.createTransaction({
      transactions: [
        {
          to,
          value: "0",
          data
        }
      ]
    });

    const execution = await safe.executeTransaction(safeTx);

    const txHash =
      (execution as any).hash ?? (execution as any).transactionResponse?.hash;

    if (!txHash) throw new Error("No transaction hash returned from Safe execution");

    const receipt = await this.provider.waitForTransaction(txHash, confirmationsToWait);
    ensureSuccessfulReceipt(receipt, "Safe group tx");

    return txHash;
  }
}
