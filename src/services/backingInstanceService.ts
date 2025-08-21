import {ResetCowSwapOrderResult, IBackingInstanceService, CreateLBPResult} from "../interfaces/IBackingInstanceService";
import {Contract, JsonRpcProvider, Wallet} from "ethers";
import CirclesBackingABI from "../abi/CirclesBackingABI.json";

export class BackingInstanceService implements IBackingInstanceService {
  constructor(private readonly rpcUrl: string, private readonly privateKey: string) {
  }

  async resetCowSwapOrder(circlesBackingInstance: string): Promise<string> {
    const provider = new JsonRpcProvider(this.rpcUrl);
    const wallet = new Wallet(this.privateKey, provider);
    const contract = new Contract(circlesBackingInstance, CirclesBackingABI, wallet);

    const tx = await contract.resetCowswapOrder();
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`resetCowswapOrder failed: ${tx.hash}`);
    }
    return tx.hash;
  }

  async createLbp(circlesBackingInstance: string): Promise<string> {
    const provider = new JsonRpcProvider(this.rpcUrl);
    const wallet = new Wallet(this.privateKey, provider);
    const contract = new Contract(circlesBackingInstance, CirclesBackingABI, wallet);

    const tx = await contract.createLBP();
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`createLBP failed: ${tx.hash}`);
    }
    return tx.hash;
  }

  async simulateCreateLbp(circlesBackingInstance: string): Promise<CreateLBPResult> {
    const provider = new JsonRpcProvider(this.rpcUrl);
    const contract = new Contract(circlesBackingInstance, CirclesBackingABI, provider);

    // 1) Simulate first to classify errors
    try {
      await contract.createLBP.staticCall();
    } catch (err: any) {
      const name = this.parseCustomError(contract, err);
      if (name === "LBPAlreadyCreated") {
        return "LBPAlreadyCreated";
      }
      if (name === "OrderNotYetFilled") {
        return "OrderNotYetFilled";
      }
      if (name === "BackingAssetBalanceInsufficient") {
        return "BackingAssetBalanceInsufficient";
      }
      throw new Error(`createLBP simulation failed: ${name ?? err?.shortMessage ?? err?.message}`);
    }

    return "Success";
  }

  async simulateResetCowSwapOrder(circlesBackingInstance: string): Promise<ResetCowSwapOrderResult> {
    const provider = new JsonRpcProvider(this.rpcUrl);
    const contract = new Contract(circlesBackingInstance, CirclesBackingABI, provider);

    // 1) Simulate to get a clean error classification without spending gas.
    try {
      await contract.resetCowswapOrder.staticCall();
    } catch (err: any) {
      const name = this.parseCustomError(contract, err);
      if (name === "OrderAlreadySettled") {
        return "OrderAlreadySettled";
      }
      if (name === "OrderUidIsTheSame") {
        return "OrderUidIsTheSame";
      }
      // Unknown custom error or non-custom revert
      throw new Error(`resetCowswapOrder simulation failed: ${name ?? err?.shortMessage ?? err?.message}`);
    }

    return "OrderValid";
  }

  parseCustomError(contract: Contract, err: any): string | undefined {
    // Try several known spots for revert data
    const candidates: unknown[] = [
      err?.data,
      err?.error?.data,
      err?.info?.error?.data,
      err?.info?.data,
      err?.cause?.data,
      err?.receipt?.revertReason // some providers include this
    ];

    for (const c of candidates) {
      try {
        if (!c) {
          continue;
        }
        const decoded = contract.interface.parseError(c as any);
        if (decoded?.name) {
          return decoded.name;
        }
      } catch {
        // fallthrough
      }
    }

    // Try to sniff a standard Error(string) message
    try {
      const reason: string | undefined =
        err?.reason ??
        err?.shortMessage ??
        err?.message;
      if (typeof reason === "string") {
        if (reason.includes("LBPAlreadyCreated")) {
          return "LBPAlreadyCreated";
        }
        if (reason.includes("OrderNotYetFilled")) {
          return "OrderNotYetFilled";
        }
        if (reason.includes("BackingAssetBalanceInsufficient")) {
          return "BackingAssetBalanceInsufficient";
        }
        if (reason.includes("OrderAlreadySettled")) {
          return "OrderAlreadySettled";
        }
        if (reason.includes("OrderUidIsTheSame")) {
          return "OrderUidIsTheSame";
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }
}