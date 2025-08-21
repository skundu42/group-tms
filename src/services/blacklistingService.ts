import {IBlacklistingService, IBlacklistServiceVerdict} from "../interfaces/IBlacklistingService";

export class BlacklistingService implements IBlacklistingService {
    constructor(private serviceUrl: string) {
        // https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify
    }

    async checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]> {
        const response = await fetch(this.serviceUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({"addresses": addresses})
        });
        if (!response.ok) {
            throw new Error(`Failed to check blacklist: ${response.statusText}`);
        }

        const data: any = await response.json();
        return data.verdicts as IBlacklistServiceVerdict[];
    }
}