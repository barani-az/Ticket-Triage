import { startMockJira } from './jiraMock.js';

const port = Number(process.env.MOCK_JIRA_PORT ?? 4010);
const mock = await startMockJira(port);
console.log(`Mock Jira listening on ${mock.baseUrl}`);
