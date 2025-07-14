# How to Use the Generalized Pierre Trading Agent

Pierre has been updated to analyze **any cryptocurrency ticker** available on Binance, not just Bitcoin. Here's how to properly prompt Pierre for the best results.

## Required Information

Pierre needs to know **which cryptocurrency ticker** you want analyzed. Always include the ticker symbol in your question.

### Supported Ticker Format
Use Binance trading pair format: `[CRYPTO]USDT`

**Examples:**
- `BTCUSDT` (Bitcoin)
- `ETHUSDT` (Ethereum) 
- `SOLUSDT` (Solana)
- `ADAUSDT` (Cardano)
- `DOTUSDT` (Polkadot)
- `AVAXUSDT` (Avalanche)
- `LINKUSDT` (Chainlink)
- `MATICUSDT` (Polygon)

## How to Prompt Pierre

### ✅ Good Examples (Ticker Specified)

```
"Can you analyze ETHUSDT for me?"

"What's the technical outlook for SOLUSDT?"

"Give me the moving average analysis for ADAUSDT"

"Is LINKUSDT in an uptrend or downtrend right now?"

"What are the key support and resistance levels for AVAXUSDT?"

"Should I be looking for a breakout in DOTUSDT?"
```

### ❌ Poor Examples (No Ticker)

```
"What's the market outlook?" 
→ Pierre will ask: "Which crypto ticker would you like me to analyze?"

"Is crypto bullish right now?"
→ Pierre will ask for a specific ticker

"Give me a technical analysis"
→ Pierre needs to know which crypto to analyze
```

## What Pierre Will Provide

For any valid ticker, Pierre delivers comprehensive analysis including:

1. **Multi-timeframe Analysis** (Daily, 4-hour, 1-hour charts)
2. **Moving Average Levels** (EMA13/25/32, MA100/300, EMA200)
3. **Current Price Context** relative to key moving averages
4. **Trend Status** across all timeframes
5. **Key Levels** that "must hold" or "must reclaim"
6. **Confluence Areas** and critical support/resistance
7. **Risk/Reward Scenarios** with specific price targets

## Pierre's Response Structure

Every analysis follows this format:
- Current price relative to moving averages
- Trend direction on D1, H4, H1 timeframes  
- Critical levels and confluence areas
- What levels "must hold" for trend continuation
- What levels "must reclaim" for reversal scenarios
- Specific price targets and risk scenarios

## Tips for Best Results

1. **Be Specific**: Always include the exact ticker (e.g., "ETHUSDT" not just "ETH")
2. **Ask About Trends**: Pierre excels at trend analysis and confluence areas
3. **Request Timeframes**: Ask about specific timeframes if you trade on particular charts
4. **Focus on Levels**: Ask about support/resistance and moving average levels

## Example Conversation

**User:** "Can you analyze SOLUSDT for me?"

**Pierre:** [Uses candlestick tool to fetch SOLUSDT data across all timeframes, then provides detailed analysis with specific price levels, moving average positions, trend status, and key levels to watch]

## Note on Non-Trading Questions

Pierre is focused on market analysis. For any non-trading questions, he will respond: "I am working, please only ask me about the market"