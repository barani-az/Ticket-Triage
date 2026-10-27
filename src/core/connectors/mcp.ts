import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Candidate, ExecResult, JsonSchema, PlanStep } from '../types.js';
import type { Connector } from './contract.js';

/**
 * A custom MCP connection ("basic"): each write tool's input schema becomes the fields the
 * questions are built from. There are no lookups, so choices come only from schema enums.
 * Tools not marked read-only are treated as writes and always need confirmation.
 */
export class McpConnector implements Connector {
  manifest = { type: 'mcp', keywords: ['mcp'], idPatterns: [] as RegExp[], basic: true };

  constructor(private client: Client, private opts: { toolName?: string } = {}) {}

  private async writeTool() {
    const { tools } = await this.client.listTools();
    const tool = this.opts.toolName
      ? tools.find((t) => t.name === this.opts.toolName)
      : tools.find((t) => !t.annotations?.readOnlyHint);
    if (!tool) throw new Error('This MCP server has no write tool.');
    return tool;
  }

  async testConnection() {
    try {
      await this.client.listTools();
      return { ok: true as const, actingAs: this.client.getServerVersion()?.name ?? 'MCP server' };
    } catch (e) {
      return { ok: false as const, error: `Could not reach the MCP server: ${(e as Error).message}` };
    }
  }

  async getSchema(_ctx: Record<string, string>): Promise<JsonSchema> {
    const tool = await this.writeTool();
    return { ...tool.inputSchema, required: tool.inputSchema.required ?? [] };
  }

  async lookup(_kind: string, _text: string): Promise<Candidate[]> {
    return [];
  }

  async execute(step: PlanStep): Promise<ExecResult> {
    try {
      const tool = await this.writeTool();
      const res = await this.client.callTool({ name: tool.name, arguments: step.params });
      const text = ((res.content as { type: string; text?: string }[])?.find((c) => c.type === 'text')?.text) ?? '';
      if (res.isError) return { ok: false, error: text || 'The tool reported an error.', retryable: false };
      const parsed = JSON.parse(text) as { id: string; url: string };
      return { ok: true, id: parsed.id, url: parsed.url };
    } catch (e) {
      return { ok: false, error: (e as Error).message, retryable: true };
    }
  }

  async close() {
    await this.client.close();
  }
}
