declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }

  export interface StatementSync {
    all(...anonymousParameters: unknown[]): unknown[];
    get(...anonymousParameters: unknown[]): unknown;
    run(...anonymousParameters: unknown[]): void;
  }
}
