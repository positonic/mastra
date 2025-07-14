# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` - Start development server using Mastra CLI
- `npm run build` - Build the project using Mastra CLI
- `npm start` - Start the built application from `.mastra/output/index.mjs`
- `npm test` - No tests currently configured
- `bun install` - Use Bun as package manager for faster installations

## Architecture Overview

This is a Mastra-based application using TypeScript and ES modules. The core architecture follows Mastra's patterns:

### Core Structure
- `/src/mastra/` - Main application directory
  - `index.ts` - Central Mastra instance configuration
  - `agents/` - AI agents with specific capabilities
  - `tools/` - Reusable tools for agents and workflows
  - `workflows/` - Multi-step workflow definitions

### Key Components

**Mastra Instance** (`src/mastra/index.ts:7`):
- Central configuration registering all agents and workflows
- Uses `@mastra/core/logger` for structured logging

**Agents** (`src/mastra/agents/index.ts`):
- `weatherAgent` - Weather information with location recommendations (GPT-4o)
- `ashAgent` - Business modeling assistant based on Ash Maurya's Lean Startup methodologies (GPT-4o)
- `pierreAgent` - Crypto trend-following trading mentor with 15+ years experience (GPT-4o-mini)
  - Specializes in technical analysis with EMA13/25/32, MA100/300, EMA200 across D1/H4/H1 timeframes
  - Uses RAG-powered trading knowledge base from 2,090-line Pierre trading system document

**Tools** (`src/mastra/tools/index.ts`):
- `weatherTool` - Fetches weather data from Open-Meteo API with geocoding
- `binancePriceTool` - Real-time cryptocurrency prices from Binance API
- `binanceCandlestickTool` - Multi-timeframe candlestick data (1d/4h/1h) with calculated moving averages
- `pierreTradingQueryTool` - RAG-powered queries against Pierre's trading knowledge base
- All tools use Zod schemas for input/output validation

**Workflows** (`src/mastra/workflows/index.ts`):
- `weatherWorkflow` - Multi-step workflow that fetches weather and suggests activities
- Two-step process: `fetchWeather` → `planActivities`
- Streams responses for real-time interaction

### Dependencies
- `@mastra/core` v0.10.10 - Core Mastra framework
- `@mastra/pg` v0.12.1 - PostgreSQL integration with vector storage
- `@ai-sdk/openai` v1.3.16 - OpenAI integration (GPT-4o, GPT-4o-mini, text-embedding-3-small)
- `zod` v3.24.3 - Schema validation
- TypeScript with ES2022 target and bundler module resolution
- ES modules (`"type": "module"`) with strict mode enabled

### RAG System (`src/mastra/rag/setup.ts`)
- PostgreSQL with pgvector extension for vector storage
- OpenAI text-embedding-3-small for embeddings (1536 dimensions)
- 2,090-line Pierre trading system document as knowledge base
- 400-word chunks with 50-word overlap for context preservation
- Cosine similarity search in `pierre_docs` table

### API Integrations
- Open-Meteo API for weather data (geocoding + forecast)
- Binance API for cryptocurrency market data (prices + candlesticks)
- OpenAI API for multiple models and embeddings

### Build System
- Mastra CLI handles building and development
- Output generated in `.mastra/output/` directory
- TypeScript compilation with strict mode enabled