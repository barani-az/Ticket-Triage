import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Candidate, ExecResult, JsonSchema, PlanStep } from '../types.js';
import type { Connector } from './contract.js';

/**
 * Connector for Atlassian's official Rovo MCP server. Unlike a generic MCP connection it knows
 * the server's lookup tools, so questions get real choices. Response shapes here come from
 * data/rovo-samples.json captured from a real site (read-only calls). Confirmed by a real
 * create: createJiraIssue returns { "data": { "id": "10013", "key": "KAN-4" } }.
 */

/** `?tools=all` exposes the full flat tool list; without it Atlassian serves a different, grouped set. */
export const ROVO_URL = 'https://mcp.atlassian.com/v2/mcp?tools=all';

const SKIPPED = new Set(['project', 'issuetype', 'reporter', 'attachment', 'issuelinks', 'issuerestriction']);
/** Optional fields we know how to ask about; any other optional field is left alone. */
const SUPPORTED_OPTIONAL = new Set(['summary', 'description', 'priority', 'assignee', 'labels', 'components']);
const ORDER = ['summary', 'parent', 'priority', 'components', 'description', 'assignee', 'labels'];

interface RovoField {
  fieldId: string;
  name: string;
  required: boolean;
  schema?: { type?: string; items?: string };
  allowedValues?: { id?: string; name?: string; value?: string }[];
}

/** Convert Rovo's field list for one issue type into the JSON Schema the questionnaire uses. */
export function fieldsToSchema(fields: RovoField[]): { properties: Record<string, JsonSchema>; required: string[] } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const f of fields) {
    if (SKIPPED.has(f.fieldId)) continue;
    if (!f.required && !SUPPORTED_OPTIONAL.has(f.fieldId)) continue;
    const prop: JsonSchema = { type: 'string', title: f.name };
    if (f.fieldId === 'assignee') prop['x-lookup'] = 'user';
    else if (f.fieldId === 'components') prop['x-lookup'] = 'component';
    else if (f.allowedValues?.length) {
      prop.enum = f.allowedValues.map((v) => v.name ?? v.value).filter((v): v is string => Boolean(v));
    }
    if (f.fieldId === 'parent') prop.title = 'Parent issue key';
    properties[f.fieldId] = prop;
    if (f.required) required.push(f.fieldId);
  }
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  required.sort((a, b) => rank(a) - rank(b));
  return { properties, required };
}

export class RovoJiraConnector implements Connector {
  manifest: Connector['manifest'] = { type: 'rovo', keywords: ['rovo', 'atlassian'], idPatterns: [] };
  private site?: { cloudId: string; url: string };
  private typeIds = new Map<string, string>(); // "PROJ/TypeName" -> issue type id
  private meta = new Map<string, RovoField[]>(); // "PROJ/TypeName" -> fields

  constructor(private client: Client, private opts: { cloudId?: string } = {}) {}

  private async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = ((res.content as { type: string; text?: string }[]) ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (res.isError) throw new Error(text || `${name} failed`);
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* plain text */
    }
    return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
  }

  private async ensureSite() {
    if (this.site) return this.site;
    const res = await this.call('getAccessibleAtlassianResources');
    const jiraSites = ((res?.resources ?? []) as any[]).filter((r) => r.products?.some((p: any) => p.id === 'jira'));
    const chosen = this.opts.cloudId ? jiraSites.find((r) => r.cloudId === this.opts.cloudId) : jiraSites[0];
    if (!chosen) throw new Error('No Jira site is available for this sign-in.');
    this.site = { cloudId: chosen.cloudId, url: String(chosen.url).replace(/\/$/, '') };
    this.manifest.live = this.site.url;
    return this.site;
  }

  async testConnection() {
    try {
      const site = await this.ensureSite();
      const me = await this.call('getJiraCurrentUser', { cloudId: site.cloudId });
      return { ok: true as const, actingAs: `${me?.displayName ?? me?.name ?? 'you'} @ ${site.url.replace('https://', '')}` };
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false as const, error: msg, needsReauth: /401|unauthori[sz]ed|invalid_token/i.test(msg) };
    }
  }

  private async types(project: string) {
    const site = await this.ensureSite();
    const res = await this.call('listJiraProjectIssueTypesMetadata', { cloudId: site.cloudId, projectIdOrKey: project });
    const list = ((res?.issueTypes ?? []) as { id: string; name: string }[]);
    for (const t of list) this.typeIds.set(`${project}/${t.name}`, String(t.id));
    return list;
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

    const cacheKey = `${ctx.project}/${ctx.issuetype}`;
    if (!this.meta.has(cacheKey)) {
      if (!this.typeIds.has(cacheKey)) await this.types(ctx.project);
      const issueTypeId = this.typeIds.get(cacheKey);
      if (!issueTypeId) return base;
      const site = await this.ensureSite();
      const res = await this.call('getJiraIssueTypeMetaWithFields', {
        cloudId: site.cloudId,
        projectIdOrKey: ctx.project,
        issueTypeId,
        requiredFieldsOnly: false,
        maxResults: 200,
      });
      this.meta.set(cacheKey, (res?.fields ?? []) as RovoField[]);
    }
    const { properties, required } = fieldsToSchema(this.meta.get(cacheKey)!);
    return {
      ...base,
      properties: { ...base.properties, ...properties },
      required: [...base.required, ...required],
    };
  }

  async lookup(kind: string, text: string, ctx: Record<string, string> = {}): Promise<Candidate[]> {
    const q = text.trim();
    const has = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
    const site = await this.ensureSite();
    switch (kind) {
      case 'project': {
        const res = await this.call('listJiraProjects', { cloudId: site.cloudId, ...(q ? { query: q } : {}) });
        return ((res?.values ?? []) as { key: string; name: string }[]).map((p) => ({ id: p.key, label: p.name, detail: p.key }));
      }
      case 'issuetype': {
        if (!ctx.project) return [];
        return (await this.types(ctx.project)).filter((t) => has(t.name)).map((t) => ({ id: t.name, label: t.name }));
      }
      case 'component': {
        if (!ctx.project) return [];
        const res = await this.call('listJiraProjectComponents', {
          cloudId: site.cloudId,
          projectIdOrKey: ctx.project,
          ...(q ? { query: q } : {}),
        });
        return ((res?.values ?? []) as { name: string }[]).map((c) => ({ id: c.name, label: c.name }));
      }
      case 'user': {
        // The lookup tool needs a query, so there are no choices until the user types a name.
        if (!q) return [];
        const res = await this.call('lookupJiraAccountId', { cloudId: site.cloudId, query: q, maxResults: 10 });
        const users = (Array.isArray(res) ? res : (res?.users ?? [])) as any[];
        return users
          .filter((u) => u.active !== false)
          .map((u) => ({ id: u.accountId, label: u.displayName, detail: u.emailAddress || undefined }));
      }
      default:
        return [];
    }
  }

  async execute(step: PlanStep): Promise<ExecResult> {
    const p = step.params;
    const args: Record<string, unknown> = {
      projectKey: p.project,
      summary: p.summary,
      issueType: p.issuetype,
    };
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'project' || k === 'issuetype' || k === 'summary') continue;
      if (['description', 'priority', 'assignee', 'parent'].includes(k)) args[k] = v;
      else if (k === 'labels') args.labels = v.split(',').map((s) => s.trim()).filter(Boolean);
      else if (k === 'components') extra.components = [{ name: v }];
      else extra[k] = v;
    }
    if (Object.keys(extra).length) args.additional_fields = extra;

    try {
      const site = await this.ensureSite();
      const res = await this.call('createJiraIssue', { cloudId: site.cloudId, ...args });
      const key = findIssueKey(res);
      if (!key) {
        // Do not mark retryable: the issue may exist, and a retry could create a duplicate.
        return { ok: false, error: `Jira may have created the issue, but its key could not be read: ${JSON.stringify(res).slice(0, 300)}`, retryable: false };
      }
      return { ok: true, id: key, url: `${site.url}/browse/${key}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: false };
    }
  }

  async close() {
    await this.client.close();
  }
}

function findIssueKey(res: unknown): string | undefined {
  const r = res as any;
  const direct = r?.key ?? r?.issue?.key ?? r?.issueKey ?? r?.issues?.[0]?.key;
  if (typeof direct === 'string') return direct;
  return JSON.stringify(res ?? '').match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0];
}
