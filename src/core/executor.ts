import fs from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import type { Connection } from './connectors/contract.js';
import type { ConfirmationCard, ExecResult, Fields, JsonSchema, PlanStep } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: false });

export interface Plan {
  step: PlanStep;
  card: ConfirmationCard;
  /** Empty when the draft passes the tool's schema. */
  errors: string[];
}

/** Check the draft against the tool's schema and build the confirmation card. */
export function buildPlan(conn: Connection, fields: Fields, schema: JsonSchema): Plan {
  const params = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.id]));
  const validate = ajv.compile(schema);
  validate(params);
  const errors = (validate.errors ?? []).map((e) =>
    e.keyword === 'required' ? `${e.params.missingProperty} is required` : `${e.instancePath.slice(1)} ${e.message}`,
  );

  const props: Record<string, JsonSchema> = schema.properties ?? {};
  const rows = Object.keys(props)
    .filter((k) => fields[k])
    .map((k) => ({
      field: k,
      title: String(props[k].title ?? k),
      value: fields[k].label,
      assumed: Boolean(fields[k].assumed),
    }));

  const warnings: string[] = [];
  if (conn.connector.manifest.basic) warnings.push('Basic connection: values could not be looked up, only checked against the schema.');
  if (conn.connector.manifest.live) warnings.push(`This creates a real issue on ${conn.connector.manifest.live}.`);
  if (conn.readOnly) warnings.push('This connection is read-only, so nothing can be created.');

  return {
    step: { connectionId: conn.id, op: 'create', params },
    card: { title: 'Create issue', connectionName: conn.name, rows, warnings },
    errors,
  };
}

export interface AuditEntry {
  at: string;
  connection: string;
  request: string;
  step: PlanStep;
  result: ExecResult;
}

/** Local log of every write: connection, request, approved plan and result. Never holds credentials. */
export class AuditLog {
  constructor(private file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(entry: AuditEntry) {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }
  list(limit = 50): AuditEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditEntry)
      .slice(-limit)
      .reverse();
  }
}

/** Runs an approved plan. Refuses on read-only connections and records every attempt. */
export async function executePlan(
  conn: Connection,
  plan: Plan,
  request: string,
  audit: AuditLog,
): Promise<ExecResult> {
  let result: ExecResult;
  if (conn.readOnly) {
    result = { ok: false, error: 'This connection is read-only.', retryable: false };
  } else if (plan.errors.length) {
    result = { ok: false, error: `Not sent: ${plan.errors.join('; ')}`, retryable: false };
  } else {
    try {
      result = await conn.connector.execute(plan.step);
    } catch (e) {
      result = { ok: false, error: (e as Error).message, retryable: true };
    }
  }
  audit.write({ at: new Date().toISOString(), connection: conn.name, request, step: plan.step, result });
  return result;
}
