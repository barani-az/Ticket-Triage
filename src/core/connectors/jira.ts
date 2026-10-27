import type { Candidate, ExecResult, JsonSchema, PlanStep } from '../types.js';
import type { Connector } from './contract.js';

export interface JiraConfig {
  baseUrl: string;
  flavor: 'cloud' | 'datacenter';
  /** Cloud only: account email for API-token basic auth. */
  email?: string;
  /** Cloud: API token. Data Center: Personal Access Token. */
  token: string;
  fetchFn?: typeof fetch;
}

class JiraError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const SKIPPED_FIELDS = new Set(['project', 'issuetype', 'reporter']);

export class JiraConnector implements Connector {
  manifest = {
    type: 'jira',
    keywords: ['jira', 'bug', 'story', 'sprint', 'ticket', 'issue'],
    idPatterns: [/\b[A-Z][A-Z0-9]+-\d+\b/],
  };

  constructor(private cfg: JiraConfig) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const auth =
      this.cfg.flavor === 'cloud'
        ? `Basic ${Buffer.from(`${this.cfg.email ?? ''}:${this.cfg.token}`).toString('base64')}`
        : `Bearer ${this.cfg.token}`;
    const res = await (this.cfg.fetchFn ?? fetch)(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new JiraError(res.status, describeError(text) || res.statusText);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async testConnection() {
    try {
      const me = await this.req<{ displayName: string }>('GET', '/rest/api/2/myself');
      return { ok: true as const, actingAs: me.displayName };
    } catch (e) {
      if (e instanceof JiraError && e.status === 401) {
        return { ok: false as const, error: 'The token was rejected. Sign in again.', needsReauth: true };
      }
      return { ok: false as const, error: `Could not reach Jira: ${(e as Error).message}` };
    }
  }

  async getSchema(ctx: Record<string, string>): Promise<JsonSchema> {
    const base = {
      type: 'object',
      properties: {
        project: { type: 'string', title: 'Project', 'x-lookup': 'project' },
        issuetype: { type: 'string', title: 'Issue type', 'x-lookup': 'issuetype' },
      } as Record<string, JsonSchema>,
      required: ['project', 'issuetype'] as string[],
    };
    if (!ctx.project || !ctx.issuetype) return base;

    const meta = await this.req<any>(
      'GET',
      `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(ctx.project)}` +
        `&issuetypeNames=${encodeURIComponent(ctx.issuetype)}&expand=projects.issuetypes.fields`,
    );
    const fields: Record<string, any> = meta.projects?.[0]?.issuetypes?.[0]?.fields ?? {};
    for (const [key, f] of Object.entries(fields)) {
      if (SKIPPED_FIELDS.has(key)) continue;
      const prop: JsonSchema = { type: 'string', title: f.name };
      if (key === 'assignee') prop['x-lookup'] = 'user';
      else if (key === 'components') prop['x-lookup'] = 'component';
      else if (Array.isArray(f.allowedValues)) {
        prop.enum = f.allowedValues.map((v: any) => v.name ?? v.value);
      }
      if (f.defaultValue?.name) prop.default = f.defaultValue.name;
      base.properties[key] = prop;
      if (f.required) base.required.push(key);
    }
    return base;
  }

  async lookup(kind: string, text: string, ctx: Record<string, string> = {}): Promise<Candidate[]> {
    const q = text.trim().toLowerCase();
    const has = (...parts: (string | undefined)[]) => !q || parts.some((p) => p?.toLowerCase().includes(q));
    switch (kind) {
      case 'project': {
        const projects = await this.req<{ key: string; name: string }[]>('GET', '/rest/api/2/project');
        return projects.filter((p) => has(p.key, p.name)).map((p) => ({ id: p.key, label: p.name, detail: p.key }));
      }
      case 'issuetype': {
        if (!ctx.project) return [];
        const project = await this.req<{ issueTypes: { name: string }[] }>('GET', `/rest/api/2/project/${ctx.project}`);
        return project.issueTypes.filter((t) => has(t.name)).map((t) => ({ id: t.name, label: t.name }));
      }
      case 'component': {
        if (!ctx.project) return [];
        const comps = await this.req<{ name: string }[]>('GET', `/rest/api/2/project/${ctx.project}/components`);
        return comps.filter((c) => has(c.name)).map((c) => ({ id: c.name, label: c.name }));
      }
      case 'user': {
        const param = this.cfg.flavor === 'cloud' ? 'query' : 'username';
        const users = await this.req<any[]>('GET', `/rest/api/2/user/search?${param}=${encodeURIComponent(q || '.')}`);
        return users.map((u) => ({
          id: u.accountId ?? u.name ?? u.key,
          label: u.displayName,
          detail: u.emailAddress,
        }));
      }
      default:
        return [];
    }
  }

  async execute(step: PlanStep): Promise<ExecResult> {
    const p = step.params;
    const fields: Record<string, unknown> = {
      project: { key: p.project },
      issuetype: { name: p.issuetype },
      summary: p.summary,
    };
    if (p.description) fields.description = p.description;
    if (p.priority) fields.priority = { name: p.priority };
    if (p.components) fields.components = [{ name: p.components }];
    if (p.assignee) fields.assignee = this.cfg.flavor === 'cloud' ? { accountId: p.assignee } : { name: p.assignee };
    try {
      const created = await this.req<{ key: string }>('POST', '/rest/api/2/issue', { fields });
      return { ok: true, id: created.key, url: `${this.cfg.baseUrl}/browse/${created.key}` };
    } catch (e) {
      const err = e as JiraError;
      return { ok: false, error: err.message, retryable: err.status >= 500 || err.status === 429 };
    }
  }
}

function describeError(body: string): string {
  try {
    const j = JSON.parse(body);
    if (j.errors) return Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
    if (j.errorMessages?.length) return j.errorMessages.join('; ');
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200);
}
