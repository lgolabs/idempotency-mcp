#!/usr/bin/env node
/**
 * MCP server for the LGO Labs Idempotency API.
 *
 * A thin stdio MCP server that proxies tool calls to the deployed HTTP API.
 *
 * Run locally:
 *   IDEMPOTENCY_API_URL=https://idempotency.lgolabs.com \
 *   IDEMPOTENCY_API_KEY=sk_... \
 *     node dist/mcp.js
 *
 * To install in Claude Desktop, add to claude_desktop_config.json:
 *   "lgolabs-idempotency": {
 *     "command": "npx",
 *     "args": ["-y", "@lgolabs/idempotency-mcp"],
 *     "env": {
 *       "IDEMPOTENCY_API_URL": "https://idempotency.lgolabs.com",
 *       "IDEMPOTENCY_API_KEY": "sk_..."
 *     }
 *   }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
const API_URL = process.env.IDEMPOTENCY_API_URL ?? 'http://localhost:8787';
const API_KEY = process.env.IDEMPOTENCY_API_KEY;
const headers = (extra = {}) => ({
    'content-type': 'application/json',
    ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    ...extra,
});
const tools = [
    {
        name: 'idempotency_claim',
        description: 'Atomically claim an idempotency key before performing a side-effecting operation. Returns fresh, in_flight, or duplicate.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Unique idempotency key (UUID recommended).' },
                namespace: { type: 'string', description: 'Optional grouping.' },
                ttl_seconds: { type: 'integer', minimum: 60, maximum: 2_592_000 },
            },
            required: ['key'],
        },
        handler: async (args) => {
            const { key, namespace, ttl_seconds } = args;
            const r = await fetch(`${API_URL}/v1/claim`, {
                method: 'POST',
                headers: headers({ 'Idempotency-Key': key }),
                body: JSON.stringify({ namespace, ttl_seconds }),
            });
            return r.json();
        },
    },
    {
        name: 'idempotency_store',
        description: 'Store the result of a successful operation against a previously-claimed key.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                lock_token: { type: 'string' },
                result: {},
                ttl_seconds: { type: 'integer', minimum: 60, maximum: 2_592_000 },
            },
            required: ['key', 'lock_token', 'result'],
        },
        handler: async (args) => {
            const r = await fetch(`${API_URL}/v1/store`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(args),
            });
            return r.json();
        },
    },
    {
        name: 'idempotency_lookup',
        description: 'Read-only inspection of a key.',
        inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
        },
        handler: async (args) => {
            const { key } = args;
            const r = await fetch(`${API_URL}/v1/lookup/${encodeURIComponent(key)}`, {
                headers: headers(),
            });
            return r.json();
        },
    },
    {
        name: 'idempotency_release',
        description: 'Voluntarily release an in-flight claim so a future claim can take over. Use this when you decide not to proceed with the operation you claimed. Requires the lock_token from idempotency_claim.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                lock_token: { type: 'string' },
            },
            required: ['key', 'lock_token'],
        },
        handler: async (args) => {
            const r = await fetch(`${API_URL}/v1/release`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(args),
            });
            return r.json();
        },
    },
    {
        name: 'idempotency_derive_key',
        description: 'Derive a deterministic idempotency key from a tool-call signature. Same {operation, inputs, scope} always returns the same key. Solves "agents pass random UUIDs every retry".',
        inputSchema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    description: 'Logical operation name, e.g. "send-email".',
                },
                inputs: {
                    type: 'object',
                    description: 'The actual parameters of the operation. Keys are sorted before hashing.',
                },
                scope: {
                    type: 'string',
                    description: 'Optional extra scoping (e.g. user id) so different scopes get different keys.',
                },
            },
            required: ['operation', 'inputs'],
        },
        handler: async (args) => {
            const r = await fetch(`${API_URL}/v1/derive-key`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(args),
            });
            return r.json();
        },
    },
    {
        name: 'idempotency_execute',
        description: 'One-shot idempotent HTTP call. Pass an idempotency key, target_url, payload, and we run the call once and cache the response. Every retry of the same key returns the cached response. Replaces the manual claim → run → store dance.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                target_url: { type: 'string', format: 'uri' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                payload: {},
                headers: { type: 'object', additionalProperties: { type: 'string' } },
                timeout_seconds: { type: 'integer', minimum: 1, maximum: 30 },
                ttl_seconds: { type: 'integer', minimum: 60, maximum: 2_592_000 },
                wait_for_in_flight_ms: { type: 'integer', minimum: 0, maximum: 10_000 },
            },
            required: ['key', 'target_url'],
        },
        handler: async (args) => {
            const r = await fetch(`${API_URL}/v1/execute`, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(args),
            });
            return r.json();
        },
    },
];
const server = new Server({ name: 'lgolabs-idempotency', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
    })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
        return {
            isError: true,
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
        };
    }
    try {
        const result = await tool.handler((args ?? {}));
        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
    }
    catch (err) {
        return {
            isError: true,
            content: [{ type: 'text', text: `error: ${err.message}` }],
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Keep process alive; transport reads stdin until EOF.
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
