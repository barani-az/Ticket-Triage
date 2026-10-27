import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JiraConnector } from '../core/connectors/jira.js';
import { createJiraMcpServer } from './jiraServer.js';

const jira = new JiraConnector({
  baseUrl: process.env.JIRA_BASE_URL ?? 'http://127.0.0.1:4010',
  flavor: process.env.JIRA_FLAVOR === 'datacenter' ? 'datacenter' : 'cloud',
  email: process.env.JIRA_EMAIL,
  token: process.env.JIRA_TOKEN ?? 'demo-token',
});

await createJiraMcpServer(jira).connect(new StdioServerTransport());
