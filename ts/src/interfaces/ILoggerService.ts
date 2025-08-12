export interface ILoggerService {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  table(data: any, columns?: readonly (string | number)[]): void;
  child(prefix: string): ILoggerService;
}