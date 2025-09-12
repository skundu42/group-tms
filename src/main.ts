import {runAll, discoverApps, runApp} from "./apps/manager";
import {resolve} from "path";
import {LoggerService} from "./services/loggerService";

const log = new LoggerService(!!process.env.VERBOSE_LOGGING, "main");

function usage() {
  log.info("Usage: node dist/src/main.js [--app <name>]");
}

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--app");
  const envApp = process.env.APP_NAME;
  const appName = idx !== -1 ? args[idx + 1] : envApp;

  if (appName) {
    const apps = discoverApps(resolve(__dirname, "apps"));
    const app = apps.find(a => a.name === appName || a.name === `${appName}`);
    if (!app) {
      log.error(`App not found: ${appName}`);
      const names = apps.map(a => a.name).join(", ");
      log.error(`Available apps: ${names || "<none>"}`);
      usage();
      process.exit(1);
    }
    runApp(app);
  } else {
    runAll();
  }
}

main();
