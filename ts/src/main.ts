import {CirclesRpcService} from "./services/circlesRpcService";
import {ChainRpcService} from "./services/chainRpcService";
import {BlacklistingService} from "./services/blacklistingService";
import {GroupService} from "./services/groupService";
import {BackingInstanceService} from "./services/backingInstanceService";
import {SlackService} from "./services/slackService";
import {LoggerService} from "./services/loggerService";
import {runOnce} from "./runner";

// Config
const rpcUrl = "https://rpc.circlesubi.network";
const blacklistingServiceUrl = "https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify";
const backersGroupAddress = "0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026";
const servicePrivateKey = "0xYourServicePrivateKey";
const serviceAddress = "0xA764b237d0f6e1F749C9422CA26d832d7287972e"; // used only for your out-of-band verification if you re-enable it
const deployedAtBlock = 39743285;
const expectedTimeTillCompletion = 60;
const slackWebhookUrl = "";
const verboseLogging = true;

const logger = new LoggerService(verboseLogging);

// Concrete services
const circlesRpc = new CirclesRpcService(rpcUrl);
const chainRpc = new ChainRpcService(rpcUrl);
const blacklistingService = new BlacklistingService(blacklistingServiceUrl);
const groupService = new GroupService(rpcUrl, servicePrivateKey);
const cowSwapService = new BackingInstanceService(rpcUrl, servicePrivateKey);
const slackService = new SlackService(slackWebhookUrl);

// One-shot run (kept for CLI usage)
runOnce(
  {
    circlesRpc,
    chainRpc,
    blacklistingService,
    groupService,
    cowSwapService,
    slackService,
    logger
  },
  {
    backersGroupAddress,
    deployedAtBlock,
    expectedTimeTillCompletion
  }
).catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
