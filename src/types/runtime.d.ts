declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  exit(code?: number): never;
};

declare module "node:fs" {
  export function readFileSync(path: string, encoding: BufferEncoding): string;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "pg" {
  export interface QueryResult<T = unknown> {
    rows: T[];
    rowCount: number | null;
  }

  export class Pool {
    constructor(config?: Record<string, unknown>);
    query<T = unknown>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    [elementName: string]: unknown;
  }
}
