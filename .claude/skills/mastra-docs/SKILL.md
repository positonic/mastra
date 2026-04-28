---
name: mastra-docs
description: Consult Mastra framework documentation for current API signatures and patterns. Use whenever modifying agents, tools, workflows, memory, server middleware, request context, or storage in this Mastra project.
---

# Mastra Documentation Reference

This is a Mastra project. Mastra's API surface evolves between versions, so before writing or modifying code that touches a Mastra primitive (`Agent`, `Memory`, `createTool`, `createWorkflow`, `Mastra` constructor, `RequestContext`, `PostgresStore`, `Observability`, etc.), verify the current API against the official docs and the installed package types.

## Primary docs entry point

https://mastra.ai/docs/getting-started/build-with-ai

This is the LLM-friendly overview that links to the rest of the docs. Start here, then drill into the specific section you need.

## Common doc paths

- Agents: https://mastra.ai/docs/agents/overview
- Memory: https://mastra.ai/docs/memory/overview
- Tools & MCP: https://mastra.ai/docs/tools-mcp/overview
- Workflows: https://mastra.ai/docs/workflows/overview
- Server middleware: https://mastra.ai/docs/server-db/middleware
- Runtime / request context: https://mastra.ai/docs/server-db/runtime-context
- Storage: https://mastra.ai/docs/server-db/storage
- Observability: https://mastra.ai/docs/observability/overview

## Workflow

1. Identify the Mastra primitive your change touches.
2. WebFetch the relevant docs page to confirm the current API shape.
3. Cross-check against the installed types in `node_modules/@mastra/core/dist/` (and any sub-packages like `@mastra/memory`, `@mastra/pg`) for the exact signatures your code will resolve to. The installed types are authoritative for what compiles.
4. Prefer current docs and installed types over training data — the framework moves fast.

## Installed version check

Run `cat package.json | grep -E '"@?mastra'` to see installed versions before consulting docs.
