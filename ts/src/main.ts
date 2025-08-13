import {CirclesRpcService} from "./services/circlesRpcService";
import {ChainRpcService} from "./services/chainRpcService";
import {BlacklistingService} from "./services/blacklistingService";
import {GroupService} from "./services/groupService";
import {BackingInstanceService} from "./services/backingInstanceService";
import {SlackService} from "./services/slackService";
import {LoggerService} from "./services/loggerService";
import {runOnce} from "./runner";
import {setInterval} from "node:timers";

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

const logger = new LoggerService(verboseLogging);

// Concrete services
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const groupService = new GroupService(rpcUrl, servicePrivateKey);
const cowSwapService = new BackingInstanceService(rpcUrl, servicePrivateKey);
const slackService = new SlackService(slackWebhookUrl);

async function run() {
  logger.info("Checking for new backers...");
  const subLogger = logger.child("runOnce");
  await runOnce({
      circlesRpc,
      chainRpc,
      blacklistingService,
      groupService,
      cowSwapService,
      slackService,
      logger: subLogger
    },
    {
      backingFactoryAddress,
      backersGroupAddress,
      deployedAtBlock,
      expectedTimeTillCompletion,
      confirmationBlocks
    }
  ).catch((error) => {
    console.error("An error occurred:", error);
    process.exit(1);
  }).finally(() => {
    logger.info("Finished checking for new backers.");
  });
}

run().then(() => {
  // Run once every minute
  setInterval(() => {
    run();
  }, 60 * 1000); // Run every minute
});

