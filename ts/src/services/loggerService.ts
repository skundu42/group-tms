import {ILoggerService} from "../interfaces/ILoggerService";

/**
 * Minimal logging utility.
 *
 * - info/warn/error always print when called.
 * - debug/table only print when verbose=true.
 * - child(prefix) creates a namespaced logger without affecting output rules.
 */
export class LoggerService implements ILoggerService {
  constructor(private readonly verbose: boolean, private readonly prefix?: string) {
  }

  private format(args: unknown[]): unknown[] {
    const havePrefix = typeof this.prefix === "string" && this.prefix.length > 0;
    if (havePrefix) {
      return [`[${this.prefix}]`, ...args];
    }
    return args;
  }

  info(...args: unknown[]): void {
    console.info(...this.format(args));
  }

  warn(...args: unknown[]): void {
    console.warn(...this.format(args));
  }

  error(...args: unknown[]): void {
    console.error(...this.format(args));
  }

  debug(...args: unknown[]): void {
    if (this.verbose) {
      console.debug(...this.format(args));
    }
  }

  table(data: any, columns?: readonly (string | number)[]): void {
    if (this.verbose) {
      // console.table has a slightly loose signature; cast to keep TS happy.
      (console as any).table(data, columns as any);
    }
  }

  child(prefix: string): ILoggerService {
    const next = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new LoggerService(this.verbose, next);
  }
}
