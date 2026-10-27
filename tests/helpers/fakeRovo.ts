import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Stands in for Atlassian's Rovo MCP server in tests. Response shapes mirror the ones captured
 * from a real site (data/rovo-samples.json): payloads wrapped in { data }, fields as
 * { fieldId, name, required, schema, allowedValues }. createJiraIssue returns { data: { id, key } },
 * confirmed by a real create.
 */
export const CLOUD_ID = '00000000-0000-4000-8000-000000000000';
export const SITE = 'https://example.atlassian.net';

const ok = (data: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ data }) }] });
const fail = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });

const TYPES = [
  { id: '10001', name: 'Epic', subtask: false },
  { id: '10002', name: 'Subtask', subtask: true },
  { id: '10003', name: 'Task', subtask: false },
  { id: '10004', name: 'Story', subtask: false },
];
const USERS = [
  { accountId: 'acc-1', displayName: 'Arjun Kumar', emailAddress: 'arjun.kumar@x.com', active: true },
  { accountId: 'acc-2', displayName: 'Arjun Rao', emailAddress: '', active: true },
  { accountId: 'acc-3', displayName: 'Old Arjun', emailAddress: '', active: false },
];

function fieldsFor(project: string, typeId: string) {
  const f: any[] = [
    { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
    { fieldId: 'description', name: 'Description', required: false, schema: { type: 'string' } },
    { fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user' } },
    { fieldId: 'reporter', name: 'Reporter', required: true, schema: { type: 'user' } },
    { fieldId: 'project', name: 'Project', required: true, schema: { type: 'project' } },
    { fieldId: 'issuetype', name: 'Issue type', required: true, schema: { type: 'issuetype' } },
    { fieldId: 'customfield_10019', name: 'Rank', required: false, schema: { type: 'any' } },
    { fieldId: 'attachment', name: 'Attachment', required: false, schema: { type: 'array', items: 'attachment' } },
  ];
  if (typeId === '10002') f.push({ fieldId: 'parent', name: 'Parent', required: true, schema: { type: 'issuelink' } });
  if (project === 'SAM1') {
    f.push({ fieldId: 'priority', name: 'Priority', required: true, schema: { type: 'priority' }, allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }, { id: '4', name: 'Low' }] });
    f.push({ fieldId: 'components', name: 'Components', required: false, schema: { type: 'array', items: 'component' } });
  }
  return f;
}

export interface FakeRovo {
  server: Server;
  calls: { name: string; args: Record<string, any> }[];
}

export function createFakeRovo(): FakeRovo {
  const calls: FakeRovo['calls'] = [];
  const server = new Server({ name: 'fake-rovo', version: '0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const a = (req.params.arguments ?? {}) as Record<string, any>;
    calls.push({ name, args: a });
    if (name !== 'getAccessibleAtlassianResources' && a.cloudId !== CLOUD_ID) return fail('cloudId is required');
    switch (name) {
      case 'getAccessibleAtlassianResources':
        return ok({ resources: [{ cloudId: CLOUD_ID, url: SITE, products: [{ id: 'confluence', access: 'read-write' }, { id: 'jira', access: 'read-write' }] }] });
      case 'getJiraCurrentUser':
        return ok({ accountId: 'me', displayName: 'Priya Nair' });
      case 'listJiraProjects': {
        const all = [{ id: '10000', key: 'KAN', name: 'My Software Team' }, { id: '10001', key: 'SAM1', name: 'Billing System Dev' }];
        const q = String(a.query ?? '').toLowerCase();
        return ok({ values: all.filter((p) => !q || p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)), total: 2, isLast: true });
      }
      case 'listJiraProjectIssueTypesMetadata':
        return ok({ issueTypes: TYPES, total: TYPES.length });
      case 'getJiraIssueTypeMetaWithFields':
        return ok({ fields: fieldsFor(a.projectIdOrKey, a.issueTypeId), total: 8 });
      case 'listJiraProjectComponents':
        return ok({ values: a.projectIdOrKey === 'SAM1' ? [{ id: '1', name: 'Frontend' }, { id: '2', name: 'Backend' }] : [], total: 2, isLast: true });
      case 'lookupJiraAccountId': {
        const q = String(a.query).toLowerCase();
        return ok(USERS.filter((u) => u.displayName.toLowerCase().includes(q)));
      }
      case 'createJiraIssue': {
        if (!a.summary) return fail('summary is required');
        if (a.issueType === 'Subtask' && !a.parent) return fail('parent is required for sub-tasks');
        return ok({ key: `${a.projectKey}-${calls.length + 40}`, id: '10050' });
      }
      default:
        return fail(`Unknown tool ${name}`);
    }
  });
  return { server, calls };
}
