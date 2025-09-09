import {runAll, discoverApps, runApp} from "./apps/manager";
import {resolve} from "path";

function usage() {
  console.log("Usage: node dist/src/main.js [--app <name>]");
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
      console.error(`App not found: ${appName}`);
      const names = apps.map(a => a.name).join(", ");
      console.error(`Available apps: ${names || "<none>"}`);
      usage();
      process.exit(1);
    }
    runApp(app);
  } else {
    runAll();
  }
}

main();
