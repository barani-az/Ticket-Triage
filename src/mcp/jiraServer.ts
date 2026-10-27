import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { JiraConnector } from '../core/connectors/jira.js';

const WRITE_TOOL = 'create_issue';

/**
 * An MCP server that exposes Jira as tools. The assistant treats it as a generic "custom MCP
 * connection": it only sees tool names and input schemas, so there are no lookups, but the
 * server fills in real project and priority choices as enums.
 */
export function createJiraMcpServer(jira: JiraConnector): Server {
  const server = new Server({ name: 'jira-mcp-demo', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const projects = await jira.lookup('project', '');
    return {
      tools: [
        {
          name: 'list_projects',
          description: 'List Jira projects the user can see.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: WRITE_TOOL,
          description: 'Create a Jira issue.',
          inputSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', title: 'Project', enum: projects.map((p) => p.id) },
              issuetype: { type: 'string', title: 'Issue type', enum: ['Bug', 'Story', 'Task'] },
              summary: { type: 'string', title: 'Summary' },
              priority: { type: 'string', title: 'Priority', enum: ['Highest', 'High', 'Medium', 'Low'], default: 'Medium' },
              components: { type: 'string', title: 'Component' },
              description: { type: 'string', title: 'Description' },
            },
            required: ['project', 'issuetype', 'summary'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === 'list_projects') {
      const projects = await jira.lookup('project', '');
      return { content: [{ type: 'text', text: JSON.stringify(projects) }] };
    }
    if (name === WRITE_TOOL) {
      const result = await jira.execute({
        connectionId: 'mcp',
        op: 'create',
        params: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])),
      });
      if (!result.ok) return { isError: true, content: [{ type: 'text', text: result.error }] };
      return { content: [{ type: 'text', text: JSON.stringify({ id: result.id, url: result.url }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
  });

  return server;
}
