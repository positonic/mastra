import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { TradescapeClient } from "tradescape-sdk";

// ==================== Tradescape Trading Tools ====================
// Tools for managing trading setups, alerts, and positions.
// Uses the Tradescape SDK to communicate with the trading platform.

function getClient(authToken?: string): TradescapeClient {
  const token = authToken || process.env.TRADESCAPE_TOKEN;
  if (!token) {
    throw new Error("No Tradescape token available. Set TRADESCAPE_TOKEN env var or provide authToken.");
  }
  
  return new TradescapeClient({
    token,
    apiUrl: process.env.TRADESCAPE_API_URL || "https://tradetronic.vercel.app",
  });
}

// ==================== Setups ====================

export const listSetupsTool = createTool({
  id: "tradescape-list-setups",
  description:
    "List trading setups from Tradescape. Use this when the user asks about their trading setups, open positions, or trade ideas.",
  inputSchema: z.object({
    status: z
      .enum(["active", "closed", "cancelled"])
      .optional()
      .describe("Filter by status"),
    limit: z.number().optional().default(10).describe("Maximum number of setups to return"),
  }),
  outputSchema: z.object({
    setups: z.array(
      z.object({
        id: z.number(),
        direction: z.string(),
        status: z.string(),
        pair: z.string().nullable(),
        entryPrice: z.number().nullable(),
        takeProfitPrice: z.number().nullable(),
        stopPrice: z.number().nullable(),
        timeframe: z.string().nullable(),
        createdAt: z.string(),
      })
    ),
    count: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`📊 [listSetups] Fetching setups with status=${inputData.status || "all"}, limit=${inputData.limit}`);
    
    try {
      const client = getClient(authToken);
      const setups = await client.setups.list({
        status: inputData.status,
        limit: inputData.limit,
      });

      const result = {
        setups: setups.map((s) => ({
          id: s.id,
          direction: s.direction,
          status: s.status,
          pair: s.pair?.symbol || null,
          entryPrice: s.entryPrice || null,
          takeProfitPrice: s.takeProfitPrice || null,
          stopPrice: s.stopPrice || null,
          timeframe: s.timeframe || null,
          createdAt: s.createdAt || new Date().toISOString(),
        })),
        count: setups.length,
      };

      console.log(`✅ [listSetups] Found ${result.count} setups`);
      return result;
    } catch (error) {
      console.error(`❌ [listSetups] FAILED:`, error);
      throw error;
    }
  },
});

export const createSetupTool = createTool({
  id: "tradescape-create-setup",
  description:
    "Create a new trading setup in Tradescape. Use this when the user wants to record a trade idea or setup.",
  inputSchema: z.object({
    pair: z.string().describe("Trading pair (e.g., BTC/USDT)"),
    direction: z.enum(["long", "short"]).describe("Trade direction"),
    entryPrice: z.number().optional().describe("Entry price"),
    takeProfitPrice: z.number().optional().describe("Take profit price"),
    stopPrice: z.number().optional().describe("Stop loss price"),
    timeframe: z.string().optional().describe("Timeframe (e.g., 1h, 4h, 1d)"),
    notes: z.string().optional().describe("Additional notes"),
  }),
  outputSchema: z.object({
    setup: z.object({
      id: z.number(),
      direction: z.string(),
      status: z.string(),
      pair: z.string(),
    }),
    message: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`📝 [createSetup] Creating ${inputData.direction} setup for ${inputData.pair}`);
    
    try {
      const client = getClient(authToken);
      const setup = await client.setups.create({
        pair: inputData.pair,
        direction: inputData.direction,
        entryPrice: inputData.entryPrice,
        takeProfitPrice: inputData.takeProfitPrice,
        stopPrice: inputData.stopPrice,
        timeframe: inputData.timeframe,
        notes: inputData.notes,
      });

      const result = {
        setup: {
          id: setup.id,
          direction: setup.direction,
          status: setup.status,
          pair: setup.pair?.symbol || inputData.pair,
        },
        message: `Created ${inputData.direction.toUpperCase()} setup for ${inputData.pair}`,
      };

      console.log(`✅ [createSetup] Created setup ID: ${setup.id}`);
      return result;
    } catch (error) {
      console.error(`❌ [createSetup] FAILED:`, error);
      throw error;
    }
  },
});

// ==================== Alerts ====================

export const listAlertsTool = createTool({
  id: "tradescape-list-alerts",
  description:
    "List price alerts from Tradescape. Use this when the user asks about their alerts or price notifications.",
  inputSchema: z.object({
    status: z
      .enum(["pending", "triggered", "cancelled"])
      .optional()
      .describe("Filter by status"),
    pair: z.string().optional().describe("Filter by trading pair"),
    limit: z.number().optional().default(10).describe("Maximum number of alerts to return"),
  }),
  outputSchema: z.object({
    alerts: z.array(
      z.object({
        id: z.string(),
        pair: z.string().nullable(),
        threshold: z.number(),
        direction: z.string(),
        status: z.string(),
        type: z.string(),
      })
    ),
    count: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`🔔 [listAlerts] Fetching alerts with status=${inputData.status || "all"}`);
    
    try {
      const client = getClient(authToken);
      const alerts = await client.alerts.list({
        status: inputData.status,
        pair: inputData.pair,
        limit: inputData.limit,
      });

      const result = {
        alerts: alerts.map((a) => ({
          id: a.id,
          pair: a.pair?.symbol || null,
          threshold: a.threshold,
          direction: a.direction,
          status: a.status,
          type: a.type,
        })),
        count: alerts.length,
      };

      console.log(`✅ [listAlerts] Found ${result.count} alerts`);
      return result;
    } catch (error) {
      console.error(`❌ [listAlerts] FAILED:`, error);
      throw error;
    }
  },
});

export const createAlertTool = createTool({
  id: "tradescape-create-alert",
  description:
    "Create a new price alert in Tradescape. Use this when the user wants to be notified when a price reaches a certain level.",
  inputSchema: z.object({
    pair: z.string().describe("Trading pair (e.g., BTC/USDT)"),
    threshold: z.number().describe("Price threshold to trigger the alert"),
    direction: z.enum(["above", "below"]).describe("Trigger when price goes above or below threshold"),
    message: z.string().optional().describe("Custom message for the alert"),
  }),
  outputSchema: z.object({
    alert: z.object({
      id: z.string(),
      pair: z.string(),
      threshold: z.number(),
      direction: z.string(),
    }),
    message: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`🔔 [createAlert] Creating alert for ${inputData.pair} ${inputData.direction} $${inputData.threshold}`);
    
    try {
      const client = getClient(authToken);
      const alert = await client.alerts.create({
        pair: inputData.pair,
        threshold: inputData.threshold,
        direction: inputData.direction,
        message: inputData.message,
      });

      const result = {
        alert: {
          id: alert.id,
          pair: alert.pair?.symbol || inputData.pair,
          threshold: alert.threshold,
          direction: alert.direction,
        },
        message: `Alert created: ${inputData.pair} ${inputData.direction} $${inputData.threshold}`,
      };

      console.log(`✅ [createAlert] Created alert ID: ${alert.id}`);
      return result;
    } catch (error) {
      console.error(`❌ [createAlert] FAILED:`, error);
      throw error;
    }
  },
});

export const deleteAlertTool = createTool({
  id: "tradescape-delete-alert",
  description: "Delete a price alert from Tradescape.",
  inputSchema: z.object({
    alertId: z.string().describe("The ID of the alert to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`🗑️ [deleteAlert] Deleting alert ${inputData.alertId}`);
    
    try {
      const client = getClient(authToken);
      await client.alerts.delete(inputData.alertId);

      console.log(`✅ [deleteAlert] Deleted alert ${inputData.alertId}`);
      return {
        success: true,
        message: `Alert ${inputData.alertId} deleted`,
      };
    } catch (error) {
      console.error(`❌ [deleteAlert] FAILED:`, error);
      throw error;
    }
  },
});

// ==================== Trades & Positions ====================

export const listPositionsTool = createTool({
  id: "tradescape-list-positions",
  description:
    "List open trading positions from Tradescape. Use this when the user asks about their current positions or holdings.",
  inputSchema: z.object({
    exchange: z.string().optional().describe("Filter by exchange (e.g., binance, bybit)"),
  }),
  outputSchema: z.object({
    positions: z.array(
      z.object({
        symbol: z.string(),
        side: z.string().nullable(),
        contracts: z.number(),
        entryPrice: z.number(),
        unrealizedPnl: z.number().nullable(),
      })
    ),
    count: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`📈 [listPositions] Fetching positions for exchange=${inputData.exchange || "all"}`);
    
    try {
      const client = getClient(authToken);
      const positions = await client.trades.positions(inputData.exchange);

      const result = {
        positions: positions.map((p) => ({
          symbol: p.symbol,
          side: p.side || null,
          contracts: p.contracts,
          entryPrice: p.entryPrice,
          unrealizedPnl: p.unrealizedPnl ?? null,
        })),
        count: positions.length,
      };

      console.log(`✅ [listPositions] Found ${result.count} positions`);
      return result;
    } catch (error) {
      console.error(`❌ [listPositions] FAILED:`, error);
      throw error;
    }
  },
});

export const syncTradesTool = createTool({
  id: "tradescape-sync-trades",
  description:
    "Sync trades from an exchange to Tradescape. Use this when the user wants to import their recent trades.",
  inputSchema: z.object({
    exchange: z.enum(["binance", "kraken", "bybit", "hyperliquid"]).describe("Exchange to sync from"),
  }),
  outputSchema: z.object({
    count: z.number(),
    message: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`🔄 [syncTrades] Syncing trades from ${inputData.exchange}`);
    
    try {
      const client = getClient(authToken);
      const result = await client.trades.sync({ exchange: inputData.exchange });

      console.log(`✅ [syncTrades] Synced ${result.count} trades`);
      return {
        count: result.count,
        message: `Synced ${result.count} trades from ${inputData.exchange}`,
      };
    } catch (error) {
      console.error(`❌ [syncTrades] FAILED:`, error);
      throw error;
    }
  },
});

// ==================== Daily Reports ====================

export const dailySummaryTool = createTool({
  id: "tradescape-daily-summary",
  description:
    "Get a daily trading summary from Tradescape. Use this when the user asks for their trading stats or daily report.",
  inputSchema: z.object({
    date: z.string().optional().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format").describe("Date in YYYY-MM-DD format (defaults to today)"),
  }),
  outputSchema: z.object({
    trades: z.object({
      count: z.number(),
      pnl: z.number().nullable(),
    }).nullable(),
    alerts: z.object({
      triggered: z.number(),
      pending: z.number(),
    }).nullable(),
    setups: z.object({
      active: z.number(),
      created: z.number(),
    }).nullable(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("tradescapeToken") as string | undefined;
    
    console.log(`📊 [dailySummary] Fetching summary for ${inputData.date || "today"}`);
    
    try {
      const client = getClient(authToken);
      const summary = await client.daily.summary({ date: inputData.date });

      console.log(`✅ [dailySummary] Got summary`);
      return {
        trades: summary.trades ? {
          count: summary.trades.count || 0,
          pnl: summary.trades.pnl ?? null,
        } : null,
        alerts: summary.alerts ? {
          triggered: summary.alerts.triggered || 0,
          pending: summary.alerts.pending || 0,
        } : null,
        setups: summary.setups ? {
          active: summary.setups.active || 0,
          created: summary.setups.created || 0,
        } : null,
      };
    } catch (error) {
      console.error(`❌ [dailySummary] FAILED:`, error);
      throw error;
    }
  },
});

// Export all tools
export const tradescapeTools = [
  listSetupsTool,
  createSetupTool,
  listAlertsTool,
  createAlertTool,
  deleteAlertTool,
  listPositionsTool,
  syncTradesTool,
  dailySummaryTool,
];
