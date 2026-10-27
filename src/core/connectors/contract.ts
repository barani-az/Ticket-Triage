import type { Candidate, ExecResult, JsonSchema, PlanStep } from '../types.js';

/** One contract per tool. A Connection is one configured instance of a connector. */
export interface Connector {
  manifest: {
    type: string;
    keywords: string[];
    idPatterns: RegExp[];
    basic?: boolean;
    /** Set for connections to a real site: shown on the confirmation card before any write. */
    live?: string;
  };
  testConnection(): Promise<
    { ok: true; actingAs: string } | { ok: false; error: string; needsReauth?: boolean }
  >;
  /**
   * JSON Schema of the fields needed for the next write. `ctx` holds the ids already chosen
   * (e.g. project, issuetype); the schema grows as those are known. Properties may carry
   * `enum`, `default` and `x-lookup` (a lookup kind the connector can resolve to real values).
   */
  getSchema(ctx: Record<string, string>): Promise<JsonSchema>;
  lookup(kind: string, text: string, ctx?: Record<string, string>): Promise<Candidate[]>;
  execute(step: PlanStep): Promise<ExecResult>;
  close?(): Promise<void>;
}

export interface Connection {
  id: string;
  name: string;
  readOnly: boolean;
  connector: Connector;
}
