import {TransactionReceipt} from "ethers";

export interface IChainRpc {
    getHeadBlock(): Promise<{
        blockNumber: number;
        timestamp: number;
    }>;
    getTransactionReceipt(txHash: string): Promise<TransactionReceipt>;
}