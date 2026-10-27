import http from 'node:http';

/**
 * A tiny in-memory stand-in for Jira's REST API (v2 paths), so the demo runs without an
 * account. It validates required fields like the real thing does, which lets the demo show
 * "the tool's own data decides".
 */

const PROJECTS = [
  { key: 'WEB', name: 'Website', issueTypes: ['Bug', 'Story', 'Task'] },
  { key: 'APP', name: 'Mobile App', issueTypes: ['Bug', 'Task'] },
];
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low'];
const COMPONENTS: Record<string, string[]> = { WEB: ['Frontend', 'Backend', 'Design'], APP: ['iOS', 'Android'] };
const USERS = [
  { accountId: 'acc-arjun-k', displayName: 'Arjun Kumar', emailAddress: 'arjun.kumar@company.com' },
  { accountId: 'acc-arjun-r', displayName: 'Arjun Rao', emailAddress: 'arjun.rao@company.com' },
  { accountId: 'acc-priya', displayName: 'Priya Nair', emailAddress: 'priya.nair@company.com' },
];

interface StoredIssue {
  key: string;
  fields: Record<string, unknown>;
}

function createMeta(projectKey: string, issueType: string) {
  const fields: Record<string, unknown> = {
    summary: { required: true, name: 'Summary', schema: { type: 'string' } },
    description: { required: false, name: 'Description', schema: { type: 'string' } },
    assignee: { required: false, name: 'Assignee', schema: { type: 'user' } },
  };
  if (issueType === 'Bug') {
    fields.priority = {
      required: true,
      name: 'Priority',
      schema: { type: 'priority' },
      hasDefaultValue: true,
      defaultValue: { name: 'Medium' },
      allowedValues: PRIORITIES.map((name) => ({ name })),
    };
    fields.components = { required: true, name: 'Component', schema: { type: 'array' } };
  }
  return { projects: [{ key: projectKey, issuetypes: [{ name: issueType, fields }] }] };
}

export function createMockJira(): { server: http.Server; issues: StoredIssue[] } {
  const issues: StoredIssue[] = [];
  let counter = 100;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname;
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (path.startsWith('/browse/')) {
      const issue = issues.find((i) => i.key === path.slice('/browse/'.length));
      if (!issue) return send(404, 'Not found', 'text/plain');
      return send(
        200,
        `<h2>${issue.key}</h2><pre>${JSON.stringify(issue.fields, null, 2).replace(/</g, '&lt;')}</pre>`,
        'text/html',
      );
    }
    if (path === '/mock/issues') return send(200, issues);

    if (!req.headers.authorization) return send(401, { errorMessages: ['Unauthorized'] });

    if (path === '/rest/api/2/myself') return send(200, { displayName: 'Priya Nair' });
    if (path === '/rest/api/2/project') return send(200, PROJECTS.map(({ key, name }) => ({ key, name })));

    const projectMatch = path.match(/^\/rest\/api\/2\/project\/([A-Z]+)(\/components)?$/);
    if (projectMatch) {
      const project = PROJECTS.find((p) => p.key === projectMatch[1]);
      if (!project) return send(404, { errorMessages: ['No project'] });
      if (projectMatch[2]) return send(200, (COMPONENTS[project.key] ?? []).map((name) => ({ name })));
      return send(200, { key: project.key, name: project.name, issueTypes: project.issueTypes.map((name) => ({ name })) });
    }

    if (path === '/rest/api/2/user/search') {
      const q = (url.searchParams.get('query') ?? url.searchParams.get('username') ?? '').toLowerCase();
      return send(200, USERS.filter((u) => q === '.' || u.displayName.toLowerCase().includes(q)));
    }

    if (path === '/rest/api/2/issue/createmeta') {
      return send(200, createMeta(url.searchParams.get('projectKeys') ?? '', url.searchParams.get('issuetypeNames') ?? ''));
    }

    if (path === '/rest/api/2/issue' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const fields = (JSON.parse(raw).fields ?? {}) as Record<string, any>;
      const projectKey = fields.project?.key;
      const issueType = fields.issuetype?.name;
      const meta = createMeta(projectKey, issueType).projects[0].issuetypes[0].fields as Record<string, any>;
      const errors: Record<string, string> = {};
      for (const [key, def] of Object.entries(meta)) {
        if (def.required && !fields[key]) errors[key] = `${def.name} is required.`;
      }
      if (fields.priority && !PRIORITIES.includes(fields.priority.name)) errors.priority = 'Priority is invalid.';
      if (!PROJECTS.find((p) => p.key === projectKey)) errors.project = 'Project is invalid.';
      if (Object.keys(errors).length) return send(400, { errors });
      const key = `${projectKey}-${++counter}`;
      issues.push({ key, fields });
      return send(201, { id: String(counter), key });
    }

    send(404, { errorMessages: ['Unknown endpoint'] });
  });

  return { server, issues };
}

export function startMockJira(port: number): Promise<{ baseUrl: string; close: () => Promise<void>; issues: StoredIssue[] }> {
  const { server, issues } = createMockJira();
  return new Promise((resolve, reject) => {
    server.once('error', reject); // e.g. EADDRINUSE: fail loudly instead of hanging
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${actual}`,
        issues,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
