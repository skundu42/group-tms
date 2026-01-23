import {CirclesRpcService} from "../../services/circlesRpcService";
import {ChainRpcService} from "../../services/chainRpcService";
import {BlacklistingService} from "../../services/blacklistingService";
import {SafeGroupService} from "../../services/safeGroupService";
import {BackingInstanceService} from "../../services/backingInstanceService";
import {SlackService} from "../../services/slackService";
import {LoggerService} from "../../services/loggerService";
import {runOnce} from "./logic";
import {formatErrorWithCauses} from "../../formatError";

const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/blacklist";
const backersGroupAddress = process.env.BACKERS_GROUP_ADDRESS || "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const backingFactoryAddress = process.env.BACKING_FACTORY_ADDRESS || "0xeced91232c609a42f6016860e8223b8aecaa7bd0";
const deployedAtBlock = Number.parseInt(process.env.START_AT_BLOCK || "39743285");
const expectedTimeTillCompletion = Number.parseInt(process.env.EXPECTED_SECONDS_TILL_COMPLETION || "60");
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const confirmationBlocks = Number.parseInt(process.env.CONFIRMATION_BLOCKS || "2");
const safeAddress = process.env.CRC_BACKERS_SAFE_ADDRESS || "";
const safeSignerPrivateKey = process.env.CRC_BACKERS_SAFE_SIGNER_PRIVATE_KEY || "";
const dryRun = process.env.DRY_RUN === "1";
const errorsBeforeCrash = 3;

const rootLogger = new LoggerService(verboseLogging);

const errors: any[] = [];

if (!dryRun) {
  if (!safeSignerPrivateKey || safeSignerPrivateKey.trim().length === 0) {
    throw new Error("CRC_BACKERS_SAFE_SIGNER_PRIVATE_KEY is required when not running crc-backers in dry-run mode");
  }

  if (!safeAddress || safeAddress.trim().length === 0) {
    throw new Error("CRC_BACKERS_SAFE_ADDRESS is required when not running crc-backers in dry-run mode");
  }
}

// Concrete services
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const slackService = new SlackService(slackWebhookUrl);
const groupService = dryRun ? undefined : new SafeGroupService(rpcUrl, safeSignerPrivateKey, safeAddress);
const cowSwapService = new BackingInstanceService(rpcUrl, safeSignerPrivateKey, safeAddress);
// Track the next block to scan purely in memory between loop iterations.
let nextFromBlock = deployedAtBlock;

process.on('SIGTERM', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 **Circles Group TMS Service Shutting Down**\n\nService received SIGTERM signal. Graceful shutdown initiated.`);
  } catch (error) {
    rootLogger.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 **Circles Group TMS Service Shutting Down**\n\nService received SIGINT signal. Graceful shutdown initiated.`);
  } catch (error) {
    rootLogger.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

async function sendStartupNotification(): Promise<void> {
  const startupMessage = `✅ **Circles Group TMS Service Started**\n\n` +
    `Service is now running and monitoring for new backers.\n` +
    `- RPC: ${rpcUrl}\n` +
    `- Group: ${backersGroupAddress}\n` +
    `- Factory: ${backingFactoryAddress}\n` +
    `- Safe: ${safeAddress || "(not set)"}\n` +
    `- Safe signer configured: ${safeSignerPrivateKey.trim().length > 0}\n` +
    `- Dry Run: ${dryRun}\n` +
    `- Start Block: ${deployedAtBlock}\n` +
    `- Error Threshold: ${errorsBeforeCrash}`;

  try {
    await slackService.notifySlackStartOrCrash(startupMessage);
    rootLogger.info("Slack startup notification sent successfully.");
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loop() {
  while (errors.length < errorsBeforeCrash) {
    try {
      rootLogger.info("Checking for new backers...");

      const logger = rootLogger.child("process");
      const outcome = await runOnce(
        {
          circlesRpc,
          chainRpc,
          blacklistingService,
          groupService,
          cowSwapService,
          slackService,
          logger: logger
        },
        {
          backingFactoryAddress,
          backersGroupAddress,
          fromBlock: nextFromBlock,
          expectedTimeTillCompletion,
          confirmationBlocks,
          dryRun
        }
      );
      nextFromBlock = outcome.nextFromBlock;
    } catch (caught: unknown) {
      const isError = caught instanceof Error;
      const baseError = isError ? caught : new Error(String(caught));

      // Wrap so your callsite (this catch frame) appears in the printed stack.
      const wrapped = new Error("runOnce failed in loop()", {cause: baseError});
      errors.push(wrapped);

      const errorIndex = errors.length;
      const thresholdReached = errorIndex >= errorsBeforeCrash;

      rootLogger.error(`Error ${errorIndex} of max. ${errorsBeforeCrash}`);
      rootLogger.error(formatErrorWithCauses(wrapped));

      if (thresholdReached) {
        rootLogger.error("Error threshold reached. Exiting with code 1.");
        
        // Send Slack notification before crashing
        try {
          const crashMessage = `🚨 **Circles Group TMS Service is CRASHING**\n\n` +
            `Error threshold reached (${errorIndex}/${errorsBeforeCrash}).\n` +
            `Last error: ${baseError.message}\n\n` +
            `Service will exit with code 1. Please investigate and restart.`;
          
          await slackService.notifySlackStartOrCrash(crashMessage);
          rootLogger.info("Slack crash notification sent successfully.");
        } catch (slackError) {
          rootLogger.error("Failed to send Slack crash notification:", slackError);
        }
        
        process.exit(1);
      }
    }

    // Wait one minute
    await delay(60 * 1000);
  }
}

async function initializeBlacklist(): Promise<void> {
  try {
    rootLogger.info("Loading blacklist from remote service...");
    await blacklistingService.loadBlacklist();
    const count = blacklistingService.getBlacklistCount();
    rootLogger.info(`Blacklist loaded successfully. ${count} addresses blacklisted.`);
  } catch (error) {
    rootLogger.error("Failed to load blacklist:", error);
    throw error;
  }
}

async function main() {
  await initializeBlacklist();
  await sendStartupNotification();
  await loop();
}

main().catch(async (err) => {
  const asError = err instanceof Error ? err : new Error(String(err));
  rootLogger.error("Fatal error in crc-backers main():");
  rootLogger.error(formatErrorWithCauses(asError));

  try {
    const crashMessage = `🚨 **Circles Group TMS Service is CRASHING**\n\n` +
      `Fatal error in main(): ${asError.message}\n\n` +
      `Service will exit with code 1. Please investigate and restart.`;
    await slackService.notifySlackStartOrCrash(crashMessage);
  } catch (slackError) {
    rootLogger.error("Failed to send Slack crash notification:", slackError);
  }

  process.exit(1);
});
