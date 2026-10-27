import fs from 'node:fs';
import path from 'node:path';
import { connectRemoteMcp } from './remote.js';

/**
 * READ-ONLY probe of Atlassian's Rovo MCP server: calls a handful of lookup tools once each and
 * saves the raw responses to data/rovo-samples.json so connector code can be written against
 * real response shapes. Nothing is created or changed.
 */
const dataDir = path.resolve('data');
const client = await connectRemoteMcp({
  url: 'https://mcp.atlassian.com/v2/mcp?tools=all',
  storeFile: path.join(dataDir, 'rovo-oauth.json'),
  log: (l) => console.log(l),
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res.content as { type: string; text?: string }[]) ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep text */
  }
  // Rovo wraps successful payloads as { data: ... }
  if (parsed && typeof parsed === 'object' && 'data' in parsed) parsed = (parsed as { data: unknown }).data;
  return { isError: Boolean(res.isError), parsed };
}

const samples: Record<string, unknown> = {};
const show = (label: string, v: unknown) => console.log(`\n## ${label}\n${JSON.stringify(v).slice(0, 700)}`);

const resources = await call('getAccessibleAtlassianResources');
samples.getAccessibleAtlassianResources = resources;
show('getAccessibleAtlassianResources', resources);

const list = (resources.parsed as any)?.resources ?? resources.parsed;
const site = Array.isArray(list) ? list[0] : undefined;
const cloudId: string | undefined = site?.id ?? site?.cloudId;
if (!cloudId) {
  console.log('\nCould not find a cloudId in the response above.');
} else {
  const projects = await call('listJiraProjects', { cloudId });
  samples.listJiraProjects = projects;
  show('listJiraProjects', projects);

  const items: any[] = (projects.parsed as any)?.values ?? (projects.parsed as any)?.projects ?? (Array.isArray(projects.parsed) ? (projects.parsed as any[]) : []);
  const key: string | undefined = items[0]?.key;
  if (key) {
    const types = await call('listJiraProjectIssueTypesMetadata', { cloudId, projectIdOrKey: key });
    samples.listJiraProjectIssueTypesMetadata = types;
    show(`listJiraProjectIssueTypesMetadata(${key})`, types);

    const tlist: any[] = (types.parsed as any)?.issueTypes ?? (types.parsed as any)?.values ?? (Array.isArray(types.parsed) ? (types.parsed as any[]) : []);
    const bug = tlist.find((t) => /bug|task/i.test(t.name)) ?? tlist[0];
    if (bug?.id) {
      const meta = await call('getJiraIssueTypeMetaWithFields', { cloudId, projectIdOrKey: key, issueTypeId: String(bug.id), requiredFieldsOnly: false });
      samples.getJiraIssueTypeMetaWithFields = meta;
      show(`getJiraIssueTypeMetaWithFields(${key}, ${bug.name})`, meta);
    }
    const comps = await call('listJiraProjectComponents', { cloudId, projectIdOrKey: key });
    samples.listJiraProjectComponents = comps;
    show('listJiraProjectComponents', comps);
  }
  const users = await call('lookupJiraAccountId', { cloudId, query: 'a', maxResults: 3 });
  samples.lookupJiraAccountId = users;
  show('lookupJiraAccountId("a")', users);
}

fs.writeFileSync(path.join(dataDir, 'rovo-samples.json'), JSON.stringify(samples, null, 2));
console.log('\nSaved data/rovo-samples.json');
await client.close();
