import {CirclesRpcService} from "../../services/circlesRpcService";
import {LoggerService} from "../../services/loggerService";
import {SlackService} from "../../services/slackService";
import {RouterService} from "../../services/routerService";
import {
  runOnce,
  RunConfig,
  DEFAULT_ENABLE_BATCH_SIZE,
  DEFAULT_BASE_GROUP_PAGE_SIZE,
  DEFAULT_AVATAR_INFO_BATCH_SIZE
} from "./logic";
import {formatErrorWithCauses} from "../../formatError";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const routerAddress = process.env.ROUTER_ADDRESS || "0xdc287474114cc0551a81ddc2eb51783fbf34802f";
const dryRun = process.env.DRY_RUN === "1";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const pollIntervalMs = parseEnvInt("ROUTER_POLL_INTERVAL_MS", 30 * 60 * 1000);
const enableBatchSize = parseEnvInt("ROUTER_ENABLE_BATCH_SIZE", DEFAULT_ENABLE_BATCH_SIZE);
const baseGroupPageSize = parseEnvInt("ROUTER_BASE_GROUP_PAGE_SIZE", DEFAULT_BASE_GROUP_PAGE_SIZE);
const avatarInfoBatchSize = parseEnvInt("ROUTER_AVATAR_INFO_BATCH_SIZE", DEFAULT_AVATAR_INFO_BATCH_SIZE);
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const servicePrivateKey = process.env.ROUTER_SERVICE_PRIVATE_KEY || process.env.SERVICE_PRIVATE_KEY || "";

const rootLogger = new LoggerService(verboseLogging, "router-tms");
const slackService = new SlackService(slackWebhookUrl);
const slackConfigured = slackWebhookUrl.trim().length > 0;
const circlesRpc = new CirclesRpcService(rpcUrl);

let routerService: RouterService | undefined;
if (!dryRun) {
  if (!servicePrivateKey || servicePrivateKey.trim().length === 0) {
    throw new Error("ROUTER_SERVICE_PRIVATE_KEY (or SERVICE_PRIVATE_KEY) is required when router-tms is not in dry-run mode.");
  }
  routerService = new RouterService(rpcUrl, routerAddress, servicePrivateKey);
}

const config: RunConfig = {
  rpcUrl,
  routerAddress,
  dryRun,
  enableBatchSize,
  baseGroupPageSize,
  avatarInfoBatchSize
};

const runLogger = rootLogger.child("run");

void notifySlackStartup();

process.on("SIGINT", async () => {
  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 **Router-TMS Service shutting down**\n\nService received SIGINT signal.`
    );
  } catch (error) {
    rootLogger.error("Failed to send shutdown notification:", error);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  try {
    await slackService.notifySlackStartOrCrash(
      `🔄 **Router-TMS Service shutting down**\n\nService received SIGTERM signal.`
    );
  } catch (error) {
    rootLogger.error("Failed to send shutdown notification:", error);
  }
  process.exit(0);
});

async function mainLoop(): Promise<void> {
  while (true) {
    try {
      const outcome = await runOnce(
        {
          circlesRpc,
          routerService,
          logger: runLogger
        },
        config
      );
      runLogger.info(
        `router-tms run completed: baseGroups=${outcome.baseGroupCount} humans=${outcome.humanTrustCount} pending=${outcome.pendingTrustCount} executed=${outcome.executedTrustCount} routerTrusts=${outcome.routerTrustCount}`
      );
      if (outcome.pendingTrustCount === 0) {
        runLogger.info("Router already trusts every required human CRC for the scanned base groups.");
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      rootLogger.error("router-tms run failed:");
      rootLogger.error(formatErrorWithCauses(error));
      void notifySlackRunError(error);
    }

    await delay(pollIntervalMs);
  }
}

mainLoop().catch((cause) => {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  rootLogger.error("Router-TMS main loop crashed:");
  rootLogger.error(formatErrorWithCauses(error));
  void slackService.notifySlackStartOrCrash(
    `🚨 **Router-TMS Service crashed**\n\nLast error: ${error.message}`
  ).catch((slackError: unknown) => {
    rootLogger.warn("Failed to send crash notification to Slack:", slackError);
  });
  process.exit(1);
});

async function notifySlackStartup(): Promise<void> {
  const pollIntervalMinutes = formatMinutes(pollIntervalMs);
  const message = `✅ **Router-TMS Service started**\n\n` +
    `Keeping the router aligned with human CRC trusts from all base groups.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- Router: ${routerAddress}\n` +
    `- Poll Interval (minutes): ${pollIntervalMinutes}\n` +
    `- Dry Run: ${dryRun}`;

  try {
    await slackService.notifySlackStartOrCrash(message);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
}

async function notifySlackRunError(error: Error): Promise<void> {
  const message = `⚠️ **Router-TMS run failed**\n\n${error.message}`;
  try {
    await slackService.notifySlackStartOrCrash(message);
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack run-error notification:", slackError);
  }
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  const rounded = Math.round(minutes * 100) / 100;
  return rounded.toString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    return fallback;
  }
  return value;
}
