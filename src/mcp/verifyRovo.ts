import path from 'node:path';
import { ROVO_URL, RovoJiraConnector } from '../core/connectors/rovo.js';
import { connectRemoteMcp } from './remote.js';

/** READ-ONLY check of the Rovo connector against the real site: nothing is created or changed. */
const client = await connectRemoteMcp({
  url: ROVO_URL,
  storeFile: path.resolve('data', 'rovo-oauth.json'),
  interactive: false,
});
const rovo = new RovoJiraConnector(client);

console.log('testConnection:', JSON.stringify(await rovo.testConnection()));
const projects = await rovo.lookup('project', '');
console.log('projects:', projects.map((p) => `${p.id} (${p.label})`).join(', '));
for (const p of projects) {
  const types = await rovo.lookup('issuetype', '', { project: p.id });
  console.log(`\n${p.id} issue types:`, types.map((t) => t.label).join(', '));
  for (const t of types.filter((x) => /task|story|bug/i.test(x.label))) {
    const s = await rovo.getSchema({ project: p.id, issuetype: t.id });
    const props = Object.entries(s.properties as Record<string, any>).map(([k, v]) => `${k}${s.required.includes(k) ? '*' : ''}${v.enum ? `[${v.enum.join('|')}]` : ''}${v['x-lookup'] ? `<${v['x-lookup']}>` : ''}`);
    console.log(`  ${t.label}: ${props.join(', ')}`);
  }
  console.log('  components:', (await rovo.lookup('component', '', { project: p.id })).map((c) => c.label).join(', ') || '(none)');
}
await client.close();
