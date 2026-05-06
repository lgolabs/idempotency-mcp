# LGO Labs — Idempotency API

> **Stripe-style idempotency keys for any AI agent tool call. One header. Pay-per-call USDC. No signup.**

Agents retry. They retry on timeouts, on partial failures, on flaky networks. Without an idempotency primitive, a single retry sends two emails, writes two database rows, or charges a customer twice. This API is that primitive — and it's fronted by an MCP server so agents can call it as a tool, not as glue.

```bash
# 30 seconds: one-shot mode (recommended)
curl -X POST https://idempotency.lgolabs.com/v1/execute \
  -H "Authorization: Bearer $LGOLABS_KEY" \
  -H "content-type: application/json" \
  -d '{
    "key":        "send-welcome-email-user-42",
    "target_url": "https://your.api/send-email",
    "payload":    { "to": "user42@example.com", "template": "welcome" }
  }'
```

The first call hits your API. Every subsequent call with the same key returns the cached response without re-calling your API. That's it.

---

## Why this exists

You can roll Redis + `SET NX` yourself in 50 lines. The product is **not running it yourself**, **MCP-native distribution**, and **pay-per-call USDC with no signup** via x402.

If you're wrapping a Stripe-style retry pattern around an LLM tool call, an external HTTP webhook, or a database write — this is the cheapest way to never ship the bug twice.

## Six endpoints, two modes

### Mode A — Bookkeeping (you control the side effect)

```
POST /v1/claim   → fresh + lock_token | in_flight + claim_age_seconds | duplicate + result
POST /v1/store   → store result against lock_token, transition to "stored"
POST /v1/release → drop your in_flight lock voluntarily (caller cancels)
GET  /v1/lookup/{key} → read-only inspection
```

### Mode B — One-shot (we run the operation for you, recommended)

```
POST /v1/execute → claim → fetch your URL → cache → return
                   { dedup: "fresh"|"duplicate", upstream: { status, body, headers } }
```

### Utilities

```
POST /v1/derive-key → deterministic key from {operation, inputs, scope}.
                      Solves "agents pass random UUIDs every retry."
GET  /healthz       → ok
```

Full spec: [`idempotency.lgolabs.com/openapi.yaml`](https://idempotency.lgolabs.com/openapi.yaml).

## Install (MCP)

In Claude Desktop, Cursor, Windsurf, Zed, or any MCP-aware client:

```jsonc
{
  "mcpServers": {
    "lgolabs-idempotency": {
      "command": "npx",
      "args": ["-y", "@lgolabs/idempotency-mcp"],
      "env": {
        "IDEMPOTENCY_API_URL": "https://idempotency.lgolabs.com",
        "IDEMPOTENCY_API_KEY": "sk_..."
      }
    }
  }
}
```

Tools exposed: `idempotency_claim`, `idempotency_store`, `idempotency_release`, `idempotency_execute`, `idempotency_derive_key`, `idempotency_lookup`.

## Install (TypeScript SDK)

```bash
npm i @lgolabs/idempotency-client
```

```ts
import { IdempotencyClient } from '@lgolabs/idempotency-client'

const idem = new IdempotencyClient({
  apiUrl: 'https://idempotency.lgolabs.com',
  apiKey: process.env.LGOLABS_KEY,
})

// One-shot: never sends duplicate emails on retry
const r = await idem.execute({
  key: 'send-welcome-email-user-42',
  targetUrl: 'https://your.api/send-email',
  payload: { to: 'user42@example.com', template: 'welcome' },
})
console.log(r.dedup)  // "fresh" first time, "duplicate" on every retry
```

## Pay-per-call without signup (x402)

Any endpoint accepts an `X-PAYMENT` header instead of `Authorization`. The first request returns a 402 with payment requirements per [x402.org](https://www.x402.org); your client signs a USDC transfer on Base, retries with the signed payload, gets the result. ~200ms settlement, no chargebacks. Free tier: 500 calls/day.

## Pricing

| Tier | Limit | Price |
|---|---|---|
| Free | 500 calls / day | $0 (API key or x402 wallet) |
| PAYG | beyond free tier | $0.001 per call |
| x402 | per call, no signup | 1000 atomic micro-USDC ($0.001) per call |

The fastest way to try it without any setup: use x402. Your client signs a USDC transfer on Base, retries with the signed payload, gets the result. ~200ms settlement, no signup.

## How it works

- **Cloudflare Durable Objects.** One DO per `(customer, idempotency_key)` ⇒ single-writer, strongly consistent. The 50-concurrent-claim test in `tests/concurrency.test.ts` asserts that exactly one caller sees `fresh` under contention.
- **TTL via DO alarm.** Each record self-expires after `ttl_seconds` (default 24h). No cron, no GC.
- **Hono on Workers.** Sub-200ms p99, scale-to-zero, global edge.
- **OpenAPI as source of truth.** The MCP server, the SDK, and `openapi.yaml` are all derived from the same contract.

## Status

v0.2 — 6 endpoints, MCP server + TypeScript SDK published, structured errors, deployed at [idempotency.lgolabs.com](https://idempotency.lgolabs.com).

## License

MIT.
