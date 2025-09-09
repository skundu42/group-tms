import {CirclesRpcService} from "../../services/circlesRpcService";
import {ChainRpcService} from "../../services/chainRpcService";
import {BlacklistingService} from "../../services/blacklistingService";
import {GroupService} from "../../services/groupService";
import {BackingInstanceService} from "../../services/backingInstanceService";
import {SlackService} from "../../services/slackService";
import {LoggerService} from "../../services/loggerService";
import {runOnce} from "./logic";
import {logger} from "bs-logger";
import {formatErrorWithCauses} from "../../formatError";

// Config
const rpcUrl = process.env.RPC_URL || "https://rpc.aboutcircles.com/";
const blacklistingServiceUrl = process.env.BLACKLISTING_SERVICE_URL || "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify";
const backersGroupAddress = process.env.BACKERS_GROUP_ADDRESS || "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const servicePrivateKey = process.env.SERVICE_PRIVATE_KEY || "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const backingFactoryAddress = process.env.BACKING_FACTORY_ADDRESS || "0xeced91232c609a42f6016860e8223b8aecaa7bd0";
const deployedAtBlock = Number.parseInt(process.env.START_AT_BLOCK || "39743285");
const expectedTimeTillCompletion = Number.parseInt(process.env.EXPECTED_SECONDS_TILL_COMPLETION || "60");
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";
const verboseLogging = !!process.env.VERBOSE_LOGGING;
const confirmationBlocks = Number.parseInt(process.env.CONFIRMATION_BLOCKS || "2");
const errorsBeforeCrash = 3;

const rootLogger = new LoggerService(verboseLogging);

// Concrete services
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const groupService = new GroupService(rpcUrl, servicePrivateKey);
const cowSwapService = new BackingInstanceService(rpcUrl, servicePrivateKey);
const slackService = new SlackService(slackWebhookUrl);

const errors: any[] = [];

process.on('SIGTERM', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 **Circles Group TMS Service Shutting Down**\n\nService received SIGTERM signal. Graceful shutdown initiated.`);
  } catch (error) {
    console.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  try {
    await slackService.notifySlackStartOrCrash(`🔄 **Circles Group TMS Service Shutting Down**\n\nService received SIGINT signal. Graceful shutdown initiated.`);
  } catch (error) {
    console.error('Failed to send shutdown notification:', error);
  }
  process.exit(0);
});

// Send startup notification
(async () => {
  try {
    const startupMessage = `✅ **Circles Group TMS Service Started**\n\n` +
      `Service is now running and monitoring for new backers.\n` +
      `- RPC: ${rpcUrl}\n` +
      `- Group: ${backersGroupAddress}\n` +
      `- Factory: ${backingFactoryAddress}\n` +
      `- Start Block: ${deployedAtBlock}\n` +
      `- Error Threshold: ${errorsBeforeCrash}`;
    
    await slackService.notifySlackStartOrCrash(startupMessage);
    rootLogger.info("Slack startup notification sent successfully.");
  } catch (slackError) {
    rootLogger.warn("Failed to send Slack startup notification:", slackError);
  }
})();

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
      await runOnce(
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
          deployedAtBlock,
          expectedTimeTillCompletion,
          confirmationBlocks
        }
      );
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

loop();
logger.info(`Process died.`);