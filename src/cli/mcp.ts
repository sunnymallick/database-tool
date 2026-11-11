/**
 * `db-tool mcp`: a stdio MCP server exposing the read-only database tools to
 * Claude Code. Register it per project, e.g.
 *
 *   claude mcp add db-tool -- ~/.local/bin/db-tool mcp --connections "Local PG"
 *
 * stdout carries the protocol, so nothing else may write to it (index.ts
 * routes console.log to stderr before this runs).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { EXTERNAL_TOOL_SPECS, ExternalTools } from '../main/external/tools';
import type { ExternalServices } from '../main/external/services';

export const SERVER_NAME = 'db-tool';

const INSTRUCTIONS =
  'Read-only access to databases the user saved in Database Tool and chose to share with Claude Code. ' +
  'Start with list_connections, then pass a connection name to every other tool. Inspect tables with ' +
  'describe_table before writing SQL or code against them. Nothing here can write: when the user wants a change ' +
  'made, write the SQL for them to run in Database Tool. Query results may contain real data; select only the ' +
  'columns and rows you need.';

/** JSON Schema for a tool's arguments (MCP requires an object schema). */
function inputSchema(shape: z.ZodRawShape): { type: 'object'; [k: string]: unknown } {
  const schema = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  delete schema.$schema;
  return { ...schema, type: 'object' };
}

export function createMcpServer(services: ExternalServices, version: string): Server {
  const tools = new ExternalTools(services, 'mcp');
  const validators = new Map(EXTERNAL_TOOL_SPECS.map((s) => [s.name, z.object(s.shape)]));
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: EXTERNAL_TOOL_SPECS.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: inputSchema(s.shape),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;
    const validator = validators.get(name);
    if (!validator) return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
    const parsed = validator.safeParse(args);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ');
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Invalid arguments: ${message}` }) }], isError: true };
    }
    const out = await tools.call(name, parsed.data, extra.signal);
    return { content: [{ type: 'text', text: out.text }], isError: out.isError };
  });

  return server;
}

/** Serve until the client disconnects, then close every database connection. */
export async function serveMcp(services: ExternalServices, version: string, transport?: Transport, signal?: AbortSignal): Promise<void> {
  const server = createMcpServer(services, version);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(transport ?? new StdioServerTransport());
  // Claude Code closes stdin when the session ends.
  if (!transport) process.stdin.on('end', () => void server.close());
  // Ctrl-C when run by hand.
  signal?.addEventListener('abort', () => void server.close(), { once: true });
  await closed;
  await services.close();
}
