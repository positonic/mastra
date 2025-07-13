# PRD: Pierre – AI Crypto Trading Mentor (Mastra-Integrated)

## Context
You already have an existing **Mastra project** set up. This PRD focuses on extending that project to support a new AI agent called **Pierre**, a virtual crypto trading mentor based on a trend-following trading system. Pierre will use **RAG** (Retrieval-Augmented Generation) for historical trading logic and fetch **live Binance market data** via API.

## Objectives
- Ingest Pierre’s strategy document as a knowledge base for RAG
- Define a `Pierre` agent using Mastra’s Agent and Tool abstractions
- Add a tool for fetching live data from Binance REST API
- Enable Pierre to reason over both static (trading lessons) and dynamic (price) context
- All development in **strict TypeScript**

---

## ✅ Tasks

### 1. Define Pierre’s Agent Persona (1pt)
- Create a new agent config in your project (e.g. `agents/pierre.ts`)
- Use `createAgent` with clear system instructions:
  > “You are Pierre, a veteran trend-following trading mentor. Use your trading system and live market data to provide guidance.”
- Attach the OpenAI GPT-4 model using `openai("gpt-4o-mini")`

---

### 2. Ingest Strategy Docs into RAG (1pt)
- Extract content from `pierre-trading-system.md`
- Chunk text (~512 tokens, overlapping)
- Generate OpenAI embeddings
- Use your existing vector store (e.g. pgvector) and upsert the chunks
- Tag index (e.g., `"pierre_docs"`)

---

### 3. Create RAG Query Tool (1pt)
- Define a tool with `createVectorQueryTool()`
- Configure to query the `"pierre_docs"` index
- Return top-k relevant chunks for a query
- Add this tool to the Pierre agent

---

### 4. Create Binance Price Fetch Tool (1pt)
- Add a tool `getLatestPrice` using `createTool()`
- Input schema: `{ symbol: string }`
- Use Binance REST endpoint:
  `https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT`
- Return `{ symbol, price }`
- Handle errors cleanly

---

### 5. Add Tools to Pierre Agent (1pt)
- In `agents/pierre.ts`, attach both tools:
  - `ragQuery`
  - `getLatestPrice`
- Update agent prompt to mention they are available

---

### 6. Enable Agent Reasoning on Live + RAG Data (1pt)
- Ensure agent uses:
  - RAG tool for trade logic
  - Binance tool for current prices
- Use Mastra’s default ReAct behavior for tool calling

---

### 7. API Integration Testing (1pt)
- Test Pierre via:
  `POST /api/agents/pierre/generate`
- Prompt: “What’s BTC/USDT price and how would you trade it?”
- Confirm:
  - Live price is fetched
  - Strategy advice is given
  - Tools are used

---

### 8. Multi-Symbol Support (1pt)
- Ensure `getLatestPrice` works for all pairs
- Use dynamic `symbol` input (e.g., `ETHUSDT`, `SOLUSDT`)
- No hardcoded values

---

### 9. Real-Time (WebSocket) Planning [Deferred]
- Future enhancement: Use Binance websocket streams
- For now, rely on REST

---

### 10. Deploy + Chat Interface (1pt)
- Deploy agent locally via `mastra dev`
- Optional: expose in UI or Slack later

---

## Deliverables
- Agent config: `agents/pierre.ts`
- Tools: `tools/getLatestPrice.ts`, `tools/queryPierreDocs.ts`
- RAG content store: `data/vector/pierre_docs`
- Deployment tested on `localhost:4111`

---

## Notes
- Stick to strict TypeScript
- Use Zod for schema validation
- Favor modular code: tools and embeddings reusable
