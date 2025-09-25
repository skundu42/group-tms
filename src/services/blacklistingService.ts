import {IBlacklistingService, IBlacklistServiceVerdict} from "../interfaces/IBlacklistingService";

const DEFAULT_TIMEOUT_MS = 30_000;

export class BlacklistingService implements IBlacklistingService {
    constructor(private serviceUrl: string, private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {
        // https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify
    }

    async checkBlacklist(addresses: string[]): Promise<IBlacklistServiceVerdict[]> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(this.serviceUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({"addresses": addresses}),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Failed to check blacklist: HTTP ${response.status} ${response.statusText}`);
            }

            const data: any = await response.json();
            if (!data || !Array.isArray(data.verdicts)) {
                throw new Error("Failed to check blacklist: malformed response payload");
            }

            return data.verdicts as IBlacklistServiceVerdict[];
        } catch (error) {
            if (error && typeof error === "object" && (error as any).name === "AbortError") {
                throw new Error("Failed to check blacklist: request timed out");
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}
