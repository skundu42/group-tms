import {runIncremental, type IncrementalState, createInitialIncrementalState} from "./logic";
import {CirclesRpcService} from "../../services/circlesRpcService";
import {ChainRpcService} from "../../services/chainRpcService";
import {GroupService} from "../../services/groupService";
import {AffiliateGroupEventsService} from "../../services/affiliateGroupEventsService";
import {SlackService} from "../../services/slackService";
import {LoggerService} from "../../services/loggerService";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const oicGroupAddress = (process.env.OIC_GROUP_ADDRESS || "").toLowerCase();
const metaOrgAddress = (process.env.OIC_META_ORG_ADDRESS || "").toLowerCase();
const affiliateRegistryAddress = (process.env.AFFILIATE_REGISTRY_ADDRESS || "0xca8222e780d046707083f51377b5fd85e2866014").toLowerCase();
const servicePrivateKey = process.env.OIC_SERVICE_PRIVATE_KEY || process.env.SERVICE_PRIVATE_KEY || "";
const deployedAtBlock = Number.parseInt(process.env.START_AT_BLOCK || "0");
const confirmationBlocks = Number.parseInt(process.env.CONFIRMATION_BLOCKS || "2");
const refreshIntervalSec = Number.parseInt(process.env.REFRESH_INTERVAL_SEC || "60");
const dryRun = process.env.OIC_DRY_RUN === "1";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const outputBatchSize = 20;

const rootLogger = new LoggerService(verboseLogging);
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
const groupService = new GroupService(rpcUrl, servicePrivateKey);
const affiliateRegistry = new AffiliateGroupEventsService(rpcUrl);

const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const slackService = new SlackService(slackWebhookUrl);
const slackConfigured = !!slackWebhookUrl;

function validateConfig() {
  if (!oicGroupAddress) throw new Error("OIC_GROUP_ADDRESS is required");
  if (!metaOrgAddress) throw new Error("OIC_META_ORG_ADDRESS is required");
  if (!servicePrivateKey && !dryRun) throw new Error("OIC_SERVICE_PRIVATE_KEY (or SERVICE_PRIVATE_KEY) is required when not in dry-run");
}

process.on('SIGTERM', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 **OIC Service Shutting Down**\n\nService received SIGTERM signal. Graceful shutdown initiated.`);
  } catch (error) {
    console.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 **OIC Service Shutting Down**\n\nService received SIGINT signal. Graceful shutdown initiated.`);
  } catch (error) {
    console.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  try {
    await slackService.notifySlackStartOrCrash(`💥 Uncaught exception: ${err?.message || err}`);
  } catch {}
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', async (reason: any) => {
  try {
    await slackService.notifySlackStartOrCrash(`💥 Unhandled rejection: ${reason?.message || String(reason)}`);
  } catch {}
  console.error(reason);
  process.exit(1);
});

// Send startup notification
(async () => {
  try {
    validateConfig();
    const startupMessage = `✅ **OIC Service Started**\n\n` +
      `Service is now running and monitoring + reconciling trust.\n` +
      `- RPC: ${rpcUrl}\n` +
      `- Group: ${oicGroupAddress}\n` +
      `- MetaOrg: ${metaOrgAddress}\n` +
      `- AffiliateRegistry: ${affiliateRegistryAddress}\n` +
      `- Start Block: ${deployedAtBlock}\n` +
      `- Confirmations: ${confirmationBlocks}\n` +
      `- Refresh (s): ${refreshIntervalSec}\n` +
      `- DryRun: ${dryRun}`;

    await slackService.notifySlackStartOrCrash(startupMessage);
    if (slackConfigured) {
      rootLogger.info("Slack startup notification sent successfully.");
    } else {
      rootLogger.info("Slack startup notification skipped (no webhook configured).");
    }
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
})();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loop() {
  const state: IncrementalState = createInitialIncrementalState();
  state.lastSafeHeadScanned = Math.max(0, deployedAtBlock - 1);
  // Only print startup/info logs once per process lifetime
  let printedStartupLogs = false;
  while (true) {
    try {
      const LOG = rootLogger.child("oic");
      if (!printedStartupLogs) {
        LOG.info("OIC app starting (monitor + reconcile trust)...");
        // Reduce noise: print config details only in verbose mode
        LOG.debug(`RPC: ${rpcUrl}`);
        LOG.debug(`Group: ${oicGroupAddress}`);
        LOG.debug(`MetaOrg: ${metaOrgAddress}`);
        LOG.debug(`AffiliateRegistry: ${affiliateRegistryAddress}`);
        LOG.debug(`DryRun: ${dryRun}`);
        printedStartupLogs = true;
      }

      await runIncremental(
        { circlesRpc, chainRpc, groupService, affiliateRegistry, logger: LOG },
        {
          confirmationBlocks,
          groupAddress: oicGroupAddress,
          metaOrgAddress,
          affiliateRegistryAddress,
          outputBatchSize,
          deployedAtBlock,
          dryRun,
        },
        state,
      );
    } catch (err) {
      rootLogger.error("OIC runOnce failed:", err);
    }

    await delay(refreshIntervalSec * 1000);
  }
}

(async () => {
  try {
    await loop();
  } catch (err) {
    rootLogger.error("Fatal error in OIC main:", err);
    process.exit(1);
  }
})();
