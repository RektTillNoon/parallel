declare module 'proper-lockfile' {
  export interface RetryOptions {
    retries?: number;
    factor?: number;
    minTimeout?: number;
    maxTimeout?: number;
  }

  export interface LockOptions {
    realpath?: boolean;
    retries?: RetryOptions;
  }

  export default function lock(
    file: string,
    options?: LockOptions,
  ): Promise<() => Promise<void>>;
}
