import {spawn} from "child_process";
import {resolve} from "path";
import {readdirSync, statSync, existsSync} from "fs";
import {LoggerService} from "../services/loggerService";

export type AppConfig = { name: string; entryPath: string; env?: Record<string, string> };

export function discoverApps(dir = __dirname): AppConfig[] {
  const entries = readdirSync(dir);
  const results: AppConfig[] = [];
  for (const name of entries) {
    const full = resolve(dir, name);
    if (name === 'manager.js') continue; 
    if (statSync(full).isDirectory()) {
      const main = resolve(full, 'main.js');
      if (existsSync(main)) {
        results.push({ name, entryPath: main });
      }
    }
  }
  return results;
}

export function runApp(app: AppConfig) {
  const entryPath = app.entryPath;
  const child = spawn(process.execPath, [entryPath], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...(app.env || {}) },
  });

  const log = new LoggerService(!!process.env.VERBOSE_LOGGING, "manager");
  log.info(`started ${app.name} (pid=${child.pid}) -> ${entryPath}`);

  child.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    log.error(`${app.name} exited with ${reason}`);
  });

  child.on("error", (err) => {
    log.error(`failed to start ${app.name}:`, err);
  });
}

export function runAll(apps: AppConfig[] = discoverApps()) {
  apps.forEach(runApp);
}

if (require.main === module) {
  runAll();
}
