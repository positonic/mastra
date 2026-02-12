import { createTool } from "@mastra/core/tools";
import { PgVector } from "@mastra/pg";
import { openai } from "@ai-sdk/openai";
import { embed } from "ai";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import {
  authenticatedTrpcCall,
  authenticatedTrpcQuery,
} from "../utils/authenticated-fetch.js";
import { getWhatsAppGateway } from "../bots/whatsapp-gateway.js";

interface GeocodingResponse {
  results: {
    latitude: number;
    longitude: number;
    name: string;
  }[];
}
interface WeatherResponse {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    weather_code: number;
  };
}

interface BinancePriceResponse {
  symbol: string;
  price: string;
}

interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  quoteAssetVolume: string;
  numberOfTrades: number;
  takerBuyBaseAssetVolume: string;
  takerBuyQuoteAssetVolume: string;
  ignore: string;
}

interface MovingAverages {
  EMA13: number;
  EMA25: number;
  EMA32: number;
  MA100: number;
  MA300: number;
  EMA200: number;
}

interface CandlestickData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Moving Average Calculation Functions
function calculateSMA(data: number[], period: number): number {
  if (data.length < period) return 0;
  const slice = data.slice(-period);
  return slice.reduce((sum, val) => sum + val, 0) / period;
}

function calculateEMA(data: number[], period: number): number {
  if (data.length < period) return 0;

  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  for (let i = period; i < data.length; i++) {
    ema = data[i] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

function calculateMovingAverages(
  candlesticks: CandlestickData[]
): MovingAverages {
  const closes = candlesticks.map((c) => c.close);

  return {
    EMA13: calculateEMA(closes, 13),
    EMA25: calculateEMA(closes, 25),
    EMA32: calculateEMA(closes, 32),
    MA100: calculateSMA(closes, 100),
    MA300: calculateSMA(closes, 300),
    EMA200: calculateEMA(closes, 200),
  };
}

export const binancePriceTool = createTool({
  id: "get-binance-price",
  description: "Get current price for a cryptocurrency pair from Binance",
  inputSchema: z.object({
    symbol: z.string().describe("Trading pair symbol (e.g., BTCUSDT, ETHUSDT)"),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    price: z.number(),
    priceString: z.string(),
  }),
  execute: async (inputData) => {
    return await getBinancePrice(inputData.symbol);
  },
});

const getBinancePrice = async (symbol: string) => {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Binance API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as BinancePriceResponse;

    return {
      symbol: data.symbol,
      price: parseFloat(data.price),
      priceString: data.price,
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch price for ${symbol}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};

export const binanceCandlestickTool = createTool({
  id: "get-binance-candlesticks",
  description:
    "Get candlestick data for multiple timeframes and calculate moving averages for Pierre's trading analysis",
  inputSchema: z.object({
    symbol: z.string().describe("Trading pair symbol (e.g., BTCUSDT, ETHUSDT)"),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    currentPrice: z.number(),
    timeframes: z.object({
      daily: z.object({
        candlesticks: z.array(
          z.object({
            timestamp: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
          })
        ),
        movingAverages: z.object({
          EMA13: z.number(),
          EMA25: z.number(),
          EMA32: z.number(),
          MA100: z.number(),
          MA300: z.number(),
          EMA200: z.number(),
        }),
      }),
      fourHour: z.object({
        candlesticks: z.array(
          z.object({
            timestamp: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
          })
        ),
        movingAverages: z.object({
          EMA13: z.number(),
          EMA25: z.number(),
          EMA32: z.number(),
          MA100: z.number(),
          MA300: z.number(),
          EMA200: z.number(),
        }),
      }),
      oneHour: z.object({
        candlesticks: z.array(
          z.object({
            timestamp: z.number(),
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number(),
          })
        ),
        movingAverages: z.object({
          EMA13: z.number(),
          EMA25: z.number(),
          EMA32: z.number(),
          MA100: z.number(),
          MA300: z.number(),
          EMA200: z.number(),
        }),
      }),
    }),
  }),
  execute: async (inputData) => {
    return await getCandlestickAnalysis(inputData.symbol);
  },
});

const getCandlestickAnalysis = async (symbol: string) => {
  const upperSymbol = symbol.toUpperCase();

  try {
    // Fetch candlestick data for all timeframes
    const [dailyData, fourHourData, oneHourData, priceData] = await Promise.all(
      [
        fetchCandlesticks(upperSymbol, "1d", 500), // 500 days for MA300
        fetchCandlesticks(upperSymbol, "4h", 500), // 500 periods for MA300
        fetchCandlesticks(upperSymbol, "1h", 500), // 500 periods for MA300
        getBinancePrice(upperSymbol),
      ]
    );

    return {
      symbol: upperSymbol,
      currentPrice: priceData.price,
      timeframes: {
        daily: {
          candlesticks: dailyData.slice(-50), // Return last 50 for context
          movingAverages: calculateMovingAverages(dailyData),
        },
        fourHour: {
          candlesticks: fourHourData.slice(-50), // Return last 50 for context
          movingAverages: calculateMovingAverages(fourHourData),
        },
        oneHour: {
          candlesticks: oneHourData.slice(-50), // Return last 50 for context
          movingAverages: calculateMovingAverages(oneHourData),
        },
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to fetch candlestick analysis for ${symbol}: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};

const fetchCandlesticks = async (
  symbol: string,
  interval: string,
  limit: number
): Promise<CandlestickData[]> => {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Binance API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  return data.map((kline: any[]) => ({
    timestamp: kline[0],
    open: parseFloat(kline[1]),
    high: parseFloat(kline[2]),
    low: parseFloat(kline[3]),
    close: parseFloat(kline[4]),
    volume: parseFloat(kline[5]),
  }));
};

export const pierreTradingQueryTool = createTool({
  id: "query-pierre-trading-system",
  description:
    "Query Pierre's trading system knowledge base for trading advice and strategies",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Trading-related question or topic to search for"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        content: z.string(),
        section: z.string(),
        relevance: z.number(),
      })
    ),
  }),
  execute: async (inputData) => {
    return await queryPierreTradingSystem(inputData.query);
  },
});

const queryPierreTradingSystem = async (query: string) => {
  const vectorStore = new PgVector({
    connectionString: process.env.DATABASE_URL!,
    schemaName: "pierre_docs",
  });

  try {
    const { embedding } = await embed({
      model: openai.embedding("text-embedding-3-small"),
      value: query,
    });

    const results = await vectorStore.query({
      vectors: [embedding],
      topK: 5,
      indexName: "pierre_trading_system",
    });

    return {
      results: results.map((result) => ({
        content: result.metadata?.content || "",
        section: result.metadata?.section || "Unknown",
        relevance: result.score || 0,
      })),
    };
  } catch (error) {
    console.error("Error querying Pierre trading system:", error);
    throw new Error(
      `Failed to query trading system: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};

export const weatherTool = createTool({
  id: "get-weather",
  description: "Get current weather for a location",
  inputSchema: z.object({
    location: z.string().describe("City name"),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    feelsLike: z.number(),
    humidity: z.number(),
    windSpeed: z.number(),
    windGust: z.number(),
    conditions: z.string(),
    location: z.string(),
  }),
  execute: async (inputData) => {
    return await getWeather(inputData.location);
  },
});

const getWeather = async (location: string) => {
  const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const geocodingResponse = await fetch(geocodingUrl);
  const geocodingData = (await geocodingResponse.json()) as GeocodingResponse;

  if (!geocodingData.results?.[0]) {
    throw new Error(`Location '${location}' not found`);
  }

  const { latitude, longitude, name } = geocodingData.results[0];

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code`;

  const response = await fetch(weatherUrl);
  const data = (await response.json()) as WeatherResponse;

  return {
    temperature: data.current.temperature_2m,
    feelsLike: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    windGust: data.current.wind_gusts_10m,
    conditions: getWeatherCondition(data.current.weather_code),
    location: name,
  };
};

function getWeatherCondition(code: number): string {
  const conditions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
  };
  return conditions[code] || "Unknown";
}

// In your Mastra agent repo
import { Tool } from "@mastra/core/tools";

// Priority values constant for project management
export const PRIORITY_VALUES = ["Quick", "Errand", "Scheduled", "Remember"];

const TODO_APP_BASE_URL =
  process.env.TODO_APP_BASE_URL || "http://localhost:3000";

export const getProjectContextTool = createTool({
  id: "get-project-context",
  description:
    "Get comprehensive project context including actions, goals, outcomes, and team members",
  inputSchema: z.object({
    projectId: z.string().describe("The project ID to get context for"),
  }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string().optional().describe("Project slug for URL construction"),
      description: z.string().optional().nullable(),
      status: z.string(),
      priority: z.string(),
      progress: z.number(),
      createdAt: z.string(),
      reviewDate: z.string().optional().nullable(),
      nextActionDate: z.string().optional().nullable(),
    }),
    actions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional().nullable(),
        status: z.string(),
        priority: z.string(),
        dueDate: z.string().optional().nullable(),
      })
    ),
    goals: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        description: z.string().optional().nullable(),
        dueDate: z.string().optional().nullable(),
        lifeDomain: z.object({
          title: z.string(),
          description: z.string().optional().nullable(),
        }).optional().nullable(),
      })
    ),
    outcomes: z.array(
      z.object({
        id: z.string(),
        description: z.string(),
        type: z.string(),
        dueDate: z.string().optional().nullable(),
      })
    ),
    teamMembers: z.array(
      z.object({
        id: z.string(),
        name: z.string().optional().nullable(),
        role: z.string().optional().nullable(),
        responsibilities: z.array(z.string()).optional().nullable(),
      })
    ),
  }),
  async execute(inputData, { requestContext }) {
    const { projectId } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`📋 [getProjectContext] INPUT: projectId=${projectId}`);
    console.log(`📋 [getProjectContext] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.projectContext",
        { projectId },
        { authToken, sessionId, userId }
      );

      console.log(`✅ [getProjectContext] SUCCESS: project="${(data as any)?.project?.name}", actions=${(data as any)?.actions?.length}, goals=${(data as any)?.goals?.length}`);
      return data;
    } catch (error) {
      console.error(`❌ [getProjectContext] FAILED:`, error);
      throw error;
    }
  },
});

export const getProjectActionsTool = createTool({
  id: "get-project-actions",
  description:
    "Get all actions for a specific project with detailed status and priority information",
  inputSchema: z.object({
    projectId: z.string().describe("The project ID to get actions for"),
    status: z
      .enum(["ACTIVE", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("Filter by action status"),
  }),
  outputSchema: z.object({
    actions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional().nullable(),
        status: z.string(),
        priority: z.string(),
        dueDate: z.string().optional().nullable(),
        project: z.object({
          id: z.string(),
          name: z.string(),
          priority: z.string(),
        }),
      })
    ),
  }),
  async execute(inputData, { requestContext }) {
    const { projectId, status } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.projectActions",
      { projectId, status },
      { authToken, sessionId, userId }
    );

    return data;
  },
});

export const createProjectActionTool = createTool({
  id: "create-project-action",
  description:
    "Create a new action for a project with specified priority and due date",
  inputSchema: z.object({
    projectId: z.string().describe("The project ID to create action for"),
    name: z.string().describe("The action name/title"),
    description: z
      .string()
      .optional()
      .describe("Detailed description of the action"),
    priority: z
      .enum(["Quick", "Scheduled", "1st Priority", "2nd Priority", "3rd Priority", "4th Priority", "5th Priority", "Errand", "Remember", "Watch", "Someday Maybe"])
      .describe("Action priority. Use 'Quick' for small tasks, 'Scheduled' for time-bound items, '1st Priority' through '5th Priority' for ranked importance, 'Errand' for errands, 'Remember' for things to keep in mind, 'Watch' for items to monitor, 'Someday Maybe' for future ideas"),
    dueDate: z.string().optional().describe("Due date in ISO format"),
  }),
  outputSchema: z.object({
    action: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().optional(),
      projectId: z.string(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const { projectId, name, description, priority, dueDate } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const contextProjectId = requestContext?.get("projectId");

    console.log(`🔧 [createProjectAction] INPUT: projectId=${projectId}, name="${name}", priority=${priority}, dueDate=${dueDate || "none"}`);
    console.log(`🔧 [createProjectAction] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}, contextProjectId=${contextProjectId || "none"}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.createAction",
        { projectId, name, description, priority, dueDate },
        { authToken, sessionId, userId }
      );

      console.log(`✅ [createProjectAction] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [createProjectAction] FAILED:`, error);
      throw error;
    }
  },
});

export const quickCreateActionTool = createTool({
  id: "quick-create-action",
  description:
    "Create a new action using natural language. Automatically parses dates like 'tomorrow' or 'next Monday' and matches project names from the text. Use this when the user wants to create an action without specifying project ID or priority explicitly.",
  inputSchema: z.object({
    text: z
      .string()
      .describe(
        "Natural language action description. Can include dates ('tomorrow', 'next week', 'today') and project names ('for Marketing project', 'add to Exercise'). Examples: 'Call John tomorrow', 'Review docs for Marketing project', 'Buy groceries next Monday'"
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    action: z.object({
      id: z.string(),
      name: z.string(),
      priority: z.string(),
      dueDate: z.string().optional().nullable(),
      project: z
        .object({
          id: z.string(),
          name: z.string(),
        })
        .optional()
        .nullable(),
    }),
    parsing: z
      .object({
        originalInput: z.string(),
        datePhrase: z.string().nullable(),
        projectPhrase: z.string().nullable(),
        matchedProject: z
          .object({
            id: z.string(),
            name: z.string(),
          })
          .nullable(),
      })
      .optional(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const projectId = requestContext?.get("projectId");

    console.log(`🎯 [quickCreateAction] INPUT: text="${inputData.text}"`);
    console.log(`🎯 [quickCreateAction] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}, projectId=${projectId || "none"}`);
    console.log(`🎯 [quickCreateAction] SENDING TO TRPC: { text: "${inputData.text}", projectId: ${projectId ? `"${projectId}"` : "undefined"} }`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    try {
      const { data: result } = await authenticatedTrpcCall(
        "mastra.quickCreateAction",
        { text: inputData.text, projectId: projectId || undefined },
        { authToken, sessionId, userId }
      );

      console.log(`✅ [quickCreateAction] SUCCESS:`, JSON.stringify(result));
      return result;
    } catch (error) {
      console.error(`❌ [quickCreateAction] FAILED:`, error);
      throw error;
    }
  },
});

export const updateProjectStatusTool = createTool({
  id: "update-project-status",
  description: "Update project status and progress information",
  inputSchema: z.object({
    projectId: z.string().describe("The project ID to update"),
    status: z
      .enum(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("New project status"),
    priority: z
      .enum(["HIGH", "MEDIUM", "LOW", "NONE"])
      .optional()
      .describe("Project priority"),
    progress: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Progress percentage (0-100)"),
    reviewDate: z
      .string()
      .optional()
      .describe("Next review date in ISO format"),
    nextActionDate: z
      .string()
      .optional()
      .describe("Next action date in ISO format"),
  }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      priority: z.string(),
      progress: z.number(),
      reviewDate: z.string().optional(),
      nextActionDate: z.string().optional(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const {
      projectId,
      status,
      priority,
      progress,
      reviewDate,
      nextActionDate,
    } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.updateProjectStatus",
      { projectId, status, priority, progress, reviewDate, nextActionDate },
      { authToken, sessionId, userId }
    );

    return data;
  },
});

export const getProjectGoalsTool = createTool({
  id: "get-project-goals",
  description:
    "Get all goals associated with a project and their alignment with life domains",
  inputSchema: z.object({
    projectId: z.string().describe("The project ID to get goals for"),
  }),
  outputSchema: z.object({
    goals: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        description: z.string().optional(),
        dueDate: z.string().optional(),
        lifeDomain: z.object({
          title: z.string(),
          description: z.string().optional(),
        }),
      })
    ),
  }),
  async execute(inputData, { requestContext }) {
    const { projectId } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    // Get project context which includes goals
    const { data: contextData } = await authenticatedTrpcCall(
      "mastra.projectContext",
      { projectId },
      { authToken, sessionId, userId }
    );

    // Extract just the goals from the project context response
    return { goals: contextData.goals || [] };
  },
});

export const getAllGoalsTool = createTool({
  id: "get-all-goals",
  description: "Get all user goals across all projects and life domains",
  inputSchema: z.object({}), // No input parameters needed - gets all goals for the authenticated user
  outputSchema: z.object({
    goals: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        description: z.string().nullable(),
        dueDate: z.string().nullable(),
        lifeDomain: z.object({
          id: z.number(),
          title: z.string(),
          description: z.string().nullable(),
        }),
        projects: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
          })
        ),
        outcomes: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
            type: z.string(),
            dueDate: z.string().nullable(),
          })
        ),
      })
    ),
    total: z.number(),
  }),
  execute: async (inputData, { requestContext }) => {
    console.log("🔍 [DEBUG] getAllGoalsTool execution started");

    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      console.error("❌ [ERROR] No auth token available");
      throw new Error("No auth token available");
    }

    const { data } = await authenticatedTrpcQuery(
      "mastra.getAllGoals",
      { authToken, sessionId, userId }
    );

    console.log("✅ [SUCCESS] Goals retrieved", {
      goalsCount: data.goals?.length || 0,
    });
    return data;
  },
});

export const getAllProjectsTool = createTool({
  id: "get-all-projects",
  description:
    "Get all user projects with their status, priority, goals, and outcomes",
  inputSchema: z.object({
    includeAll: z.boolean().optional().default(false).describe(
      "When false (default), only returns ACTIVE projects. When true, returns all projects regardless of status."
    ),
  }),
  outputSchema: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string().optional().describe("Project slug for URL construction"),
        description: z.string().nullable(),
        status: z.string(),
        priority: z.string(),
        createdAt: z.string(),
        reviewDate: z.string().nullable(),
        nextActionDate: z.string().nullable(),
        goals: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            description: z.string().nullable(),
            dueDate: z.string().nullable(),
            lifeDomainId: z.number(),
          })
        ),
        outcomes: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
            type: z.string().nullable(),
            dueDate: z.string().nullable(),
          })
        ),
      })
    ),
    total: z.number(),
    filtered: z.boolean().describe("True if results were filtered to ACTIVE projects only"),
  }),
  async execute(inputData, { requestContext }) {
    console.log("🚀 [getAllProjectsTool] Starting execution");

    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const workspaceId = requestContext?.get("workspaceId");

    if (!authToken) {
      console.error("❌ [getAllProjectsTool] No auth token available");
      throw new Error("No auth token available");
    }

    // Pass workspaceId to filter projects to current workspace
    const queryInput = workspaceId ? { json: { workspaceId } } : undefined;
    const endpoint = queryInput
      ? `project.getAll?input=${encodeURIComponent(JSON.stringify(queryInput))}`
      : "project.getAll";

    const { data } = await authenticatedTrpcQuery(
      endpoint,
      { authToken, sessionId, userId }
    );

    // The API returns projects nested in result.data.json
    const projects = Array.isArray(data)
      ? data
      : data.json || data || [];

    // Ensure projects is always an array
    const projectsArray = Array.isArray(projects) ? projects : [];

    // Extract includeAll from inputData (defaults to false)
    const includeAll = inputData?.includeAll ?? false;

    // Filter to ACTIVE projects unless includeAll is true
    const filteredProjects = includeAll
      ? projectsArray
      : projectsArray.filter((project: any) => project.status === 'ACTIVE');

    const result = {
      projects: filteredProjects.map((project: any) => ({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        status: project.status,
        priority: project.priority,
        createdAt: project.createdAt,
        reviewDate: project.reviewDate,
        nextActionDate: project.nextActionDate,
        goals:
          project.goals?.map((goal: any) => ({
            id: goal.id,
            title: goal.title,
            description: goal.description,
            dueDate: goal.dueDate,
            lifeDomainId: goal.lifeDomainId,
          })) || [],
        outcomes:
          project.outcomes?.map((outcome: any) => ({
            id: outcome.id,
            description: outcome.description,
            type: outcome.type,
            dueDate: outcome.dueDate,
          })) || [],
      })),
      total: filteredProjects.length,
      filtered: !includeAll,
    };

    console.log(`✅ [getAllProjectsTool] Retrieved ${result.total} projects`);
    return result;
  },
});

// Initialize Slack Web Client
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Define Block Kit element schema
const slackBlockElementSchema = z.object({
  type: z.string(),
  text: z
    .object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean().optional(),
      verbatim: z.boolean().optional(),
    })
    .optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  action_id: z.string().optional(),
  style: z.string().optional(),
  confirm: z.any().optional(),
  placeholder: z
    .object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean().optional(),
    })
    .optional(),
  initial_value: z.string().optional(),
  options: z
    .array(
      z.object({
        text: z.object({
          type: z.string(),
          text: z.string(),
          emoji: z.boolean().optional(),
        }),
        value: z.string(),
      })
    )
    .optional(),
});

// Define Block Kit block schema
const slackBlockSchema = z.object({
  type: z.string(),
  text: z
    .object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean().optional(),
      verbatim: z.boolean().optional(),
    })
    .optional(),
  elements: z.array(slackBlockElementSchema).optional(),
  accessory: slackBlockElementSchema.optional(),
  block_id: z.string().optional(),
  fields: z
    .array(
      z.object({
        type: z.string(),
        text: z.string(),
        emoji: z.boolean().optional(),
        verbatim: z.boolean().optional(),
      })
    )
    .optional(),
  image_url: z.string().optional(),
  alt_text: z.string().optional(),
  title: z
    .object({
      type: z.string(),
      text: z.string(),
      emoji: z.boolean().optional(),
    })
    .optional(),
});

export const sendSlackMessageTool = createTool({
  id: "send-slack-message",
  description: "Send a message to a Slack channel or user",
  inputSchema: z.object({
    channel: z
      .string()
      .describe(
        "The channel ID or user ID to send the message to (e.g., C1234567890 or U1234567890)"
      ),
    text: z.string().describe("The text content of the message"),
    blocks: z
      .array(slackBlockSchema)
      .optional()
      .describe("Optional Block Kit blocks for rich formatting"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string().describe("Timestamp of the message"),
    message: z
      .object({
        text: z.string(),
        type: z.string(),
        user: z.string(),
        ts: z.string(),
      })
      .optional(),
  }),
  execute: async (inputData) => {
    const { channel, text, blocks } = inputData;
    try {
      const result = await slackClient.chat.postMessage({
        channel,
        text,
        blocks,
      });

      return {
        ok: result.ok || false,
        channel: result.channel || "",
        ts: result.ts || "",
        message: result.message
          ? {
              text: result.message.text || "",
              type: result.message.type || "",
              user: result.message.user || "",
              ts: result.message.ts || "",
            }
          : undefined,
      };
    } catch (error) {
      throw new Error(
        `Failed to send Slack message: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  },
});

export const updateSlackMessageTool = createTool({
  id: "update-slack-message",
  description: "Update an existing Slack message",
  inputSchema: z.object({
    channel: z.string().describe("The channel ID where the message was posted"),
    ts: z.string().describe("The timestamp of the message to update"),
    text: z.string().describe("The new text content of the message"),
    blocks: z
      .array(slackBlockSchema)
      .optional()
      .describe("Optional Block Kit blocks for rich formatting"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string(),
    text: z.string(),
  }),
  execute: async (inputData) => {
    const { channel, ts, text, blocks } = inputData;
    try {
      const result = await slackClient.chat.update({
        channel,
        ts,
        text,
        blocks,
      });

      return {
        ok: result.ok || false,
        channel: result.channel || "",
        ts: result.ts || "",
        text: result.text || "",
      };
    } catch (error) {
      throw new Error(
        `Failed to update Slack message: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  },
});

export const getSlackUserInfoTool = createTool({
  id: "get-slack-user-info",
  description: "Get information about a Slack user",
  inputSchema: z.object({
    user: z
      .string()
      .describe("The user ID to get information for (e.g., U1234567890)"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    user: z
      .object({
        id: z.string(),
        name: z.string(),
        real_name: z.string().optional(),
        tz: z.string().optional(),
        tz_label: z.string().optional(),
        is_bot: z.boolean(),
        is_admin: z.boolean().optional(),
        is_owner: z.boolean().optional(),
      })
      .optional(),
  }),
  execute: async (inputData) => {
    const { user } = inputData;
    try {
      const result = await slackClient.users.info({ user });

      if (!result.ok || !result.user) {
        return { ok: false };
      }

      return {
        ok: true,
        user: {
          id: result.user.id || "",
          name: result.user.name || "",
          real_name: result.user.real_name,
          tz: result.user.tz,
          tz_label: result.user.tz_label,
          is_bot: result.user.is_bot || false,
          is_admin: result.user.is_admin,
          is_owner: result.user.is_owner,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to get Slack user info: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  },
});

export const getMeetingTranscriptionsTool = createTool({
  id: "get-meeting-transcriptions",
  description:
    "Get meeting and call transcriptions. Use this for any request about calls, meetings, phone conversations, or video calls. Supports filtering by project, date range, participants, or meeting type.",
  inputSchema: z.object({
    projectId: z.string().optional().describe("Filter by specific project ID"),
    startDate: z
      .string()
      .optional()
      .describe("Start date filter in ISO format"),
    endDate: z.string().optional().describe("End date filter in ISO format"),
    participants: z
      .array(z.string())
      .optional()
      .describe("Filter by participant names/IDs"),
    meetingType: z
      .string()
      .optional()
      .describe("Filter by meeting type (standup, planning, review, etc.)"),
    limit: z
      .number()
      .optional()
      .default(5)
      .describe("Maximum number of transcriptions to return (default: 5)"),
    truncateTranscript: z
      .boolean()
      .optional()
      .default(true)
      .describe("Truncate transcript to prevent context overflow (default: true)"),
    maxTranscriptLength: z
      .number()
      .optional()
      .default(2000)
      .describe("Max characters per transcript when truncating (default: 2000)"),
  }),
  outputSchema: z.object({
    transcriptions: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        transcript: z.string(),
        participants: z.array(z.string()),
        meetingDate: z.string(),
        meetingType: z.string().optional(),
        projectId: z.string().optional(),
        duration: z.number().optional(),
        summary: z.string().optional(),
      })
    ),
    total: z.number(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { projectId, startDate, endDate, participants, meetingType, limit, truncateTranscript, maxTranscriptLength } =
      inputData;

    console.log("🔍 [getMeetingTranscriptions] Starting execution");

    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      console.error("❌ [getMeetingTranscriptions] No authentication token available");
      throw new Error("No authentication token available");
    }

    const { data: result } = await authenticatedTrpcCall(
      "mastra.getMeetingTranscriptions",
      { projectId, startDate, endDate, participants, meetingType, limit },
      { authToken, sessionId, userId }
    );

    // Truncate transcripts to prevent context overflow
    if (truncateTranscript && result.transcriptions) {
      result.transcriptions = result.transcriptions.map((t: any) => ({
        ...t,
        transcript: t.transcript && t.transcript.length > maxTranscriptLength
          ? t.transcript.slice(0, maxTranscriptLength) + '...[truncated]'
          : t.transcript,
      }));
    }

    console.log(`✅ [getMeetingTranscriptions] Retrieved ${result.transcriptions?.length || 0} transcriptions`);
    return result;
  },
});

export const queryMeetingContextTool = createTool({
  id: "query-meeting-context",
  description:
    "Semantic search across meeting and call transcriptions to find decisions, action items, deadlines, and project discussions. Use this for searching specific topics discussed in calls or meetings.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Search query for finding relevant meeting content"),
    projectId: z
      .string()
      .optional()
      .describe("Limit search to specific project"),
    dateRange: z
      .object({
        start: z.string(),
        end: z.string(),
      })
      .optional()
      .describe("Date range to search within"),
    topK: z
      .number()
      .optional()
      .default(5)
      .describe("Number of most relevant results to return"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        content: z.string(),
        meetingTitle: z.string(),
        meetingDate: z.string(),
        participants: z.array(z.string()),
        meetingType: z.string().optional(),
        projectId: z.string().optional(),
        relevanceScore: z.number(),
        contextType: z
          .enum([
            "decision",
            "action_item",
            "deadline",
            "blocker",
            "discussion",
            "update",
          ])
          .optional(),
      })
    ),
  }),
  execute: async (inputData, { requestContext }) => {
    const { query, projectId, dateRange, topK } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.queryMeetingContext",
      { query, projectId, dateRange, topK },
      { authToken, sessionId, userId }
    );

    return data;
  },
});

export const getMeetingInsightsTool = createTool({
  id: "get-meeting-insights",
  description:
    "Extract key insights from recent meetings and calls including decisions, action items, deadlines, and project evolution. Use this to summarize what was discussed in calls or meetings.",
  inputSchema: z.object({
    projectId: z.string().optional().describe("Focus on specific project"),
    timeframe: z
      .enum(["last_week", "last_month", "last_quarter", "custom"])
      .default("last_week")
      .describe("Time period for insights"),
    startDate: z
      .string()
      .optional()
      .describe("Custom start date if timeframe is custom"),
    endDate: z
      .string()
      .optional()
      .describe("Custom end date if timeframe is custom"),
    insightTypes: z
      .array(
        z.enum([
          "decisions",
          "action_items",
          "deadlines",
          "blockers",
          "milestones",
          "team_updates",
        ])
      )
      .optional()
      .describe("Types of insights to extract"),
  }),
  outputSchema: z.object({
    insights: z.object({
      decisions: z.array(
        z.object({
          decision: z.string(),
          context: z.string(),
          meetingDate: z.string(),
          participants: z.array(z.string()),
          impact: z.enum(["high", "medium", "low"]).optional(),
        })
      ),
      actionItems: z.array(
        z.object({
          action: z.string(),
          assignee: z.string().optional(),
          dueDate: z.string().optional(),
          status: z.enum(["pending", "in_progress", "completed"]).optional(),
          meetingDate: z.string(),
          priority: z.enum(["high", "medium", "low"]).optional(),
        })
      ),
      deadlines: z.array(
        z.object({
          deadline: z.string(),
          description: z.string(),
          dueDate: z.string(),
          owner: z.string().optional(),
          status: z.enum(["upcoming", "overdue", "completed"]).optional(),
          meetingDate: z.string(),
        })
      ),
      blockers: z.array(
        z.object({
          blocker: z.string(),
          impact: z.string(),
          owner: z.string().optional(),
          resolution: z.string().optional(),
          meetingDate: z.string(),
          severity: z.enum(["critical", "high", "medium", "low"]).optional(),
        })
      ),
      milestones: z.array(
        z.object({
          milestone: z.string(),
          targetDate: z.string().optional(),
          progress: z.string().optional(),
          meetingDate: z.string(),
          status: z.enum(["planned", "in_progress", "achieved"]).optional(),
        })
      ),
      teamUpdates: z.array(
        z.object({
          member: z.string(),
          update: z.string(),
          category: z
            .enum(["progress", "blocker", "achievement", "challenge"])
            .optional(),
          meetingDate: z.string(),
        })
      ),
    }),
    summary: z.object({
      totalMeetings: z.number(),
      timeframe: z.string(),
      keyThemes: z.array(z.string()),
      projectProgress: z.string().optional(),
      upcomingDeadlines: z.number(),
      activeBlockers: z.number(),
    }),
  }),
  execute: async (inputData, { requestContext }) => {
    const { projectId, timeframe, startDate, endDate, insightTypes } = inputData;
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.getMeetingInsights",
      { projectId, timeframe, startDate, endDate, insightTypes },
      { authToken, sessionId, userId }
    );

    return data;
  },
});

export const getCalendarEventsTool = createTool({
  id: "get-calendar-events",
  description:
    "Get calendar events for today or upcoming days. Use this tool for any request about calendar, schedule, meetings today, upcoming meetings, what's on the calendar, or scheduled events. This retrieves actual calendar/scheduled events, NOT past meeting transcriptions.",
  inputSchema: z.object({
    timeframe: z
      .enum(["today", "upcoming", "custom"])
      .default("today")
      .describe(
        "'today' for today's events, 'upcoming' for next N days, 'custom' for specific date range"
      ),
    days: z
      .number()
      .min(1)
      .max(30)
      .optional()
      .default(7)
      .describe("Number of days to look ahead (only used when timeframe='upcoming')"),
    timeMin: z
      .string()
      .optional()
      .describe("Start date in ISO format (only for timeframe='custom')"),
    timeMax: z
      .string()
      .optional()
      .describe("End date in ISO format (only for timeframe='custom')"),
  }),
  outputSchema: z.object({
    events: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        description: z.string().optional(),
        start: z.string(),
        end: z.string(),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        htmlLink: z.string().optional(),
        status: z.string().optional(),
      })
    ),
    calendarConnected: z.boolean(),
    error: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { timeframe, days, timeMin, timeMax } = inputData;

    console.log("📅 [getCalendarEvents] Starting execution");

    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      console.error("❌ [getCalendarEvents] No authentication token available");
      throw new Error("No authentication token available");
    }

    const { data: result } = await authenticatedTrpcCall(
      "mastra.getCalendarEvents",
      { timeframe, days, timeMin, timeMax },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [getCalendarEvents] Retrieved ${result.events?.length || 0} events`);
    return result;
  },
});

// ==================== ENHANCED CALENDAR TOOLS ====================

export const getTodayCalendarEventsTool = createTool({
  id: "get-today-calendar-events",
  description: "Get all calendar events for today from all connected providers (Google + Microsoft). Quick way to see today's schedule.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    events: z.array(z.object({
      id: z.string(),
      summary: z.string(),
      start: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
      }),
      end: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
      }),
      location: z.string().optional(),
      attendees: z.array(z.any()).optional(),
      provider: z.enum(['google', 'microsoft']).optional(),
    })),
    date: z.string(),
  }),
  execute: async (_inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.getTodayCalendarEvents",
      {},
      { authToken, sessionId, userId }
    );

    return { events: data.events, date: data.date };
  },
});

export const getUpcomingCalendarEventsTool = createTool({
  id: "get-upcoming-calendar-events",
  description: "Get upcoming calendar events for the next N days (default 7) from all connected providers. Useful for weekly planning.",
  inputSchema: z.object({
    days: z.number().min(1).max(30).default(7).describe("Number of days to look ahead (1-30)"),
  }),
  outputSchema: z.object({
    events: z.array(z.object({
      id: z.string(),
      summary: z.string(),
      start: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
      }),
      end: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
      }),
      location: z.string().optional(),
      provider: z.enum(['google', 'microsoft']).optional(),
    })),
    days: z.number(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.getUpcomingCalendarEvents",
      { days: inputData.days },
      { authToken, sessionId, userId }
    );

    return { events: data.events, days: data.days };
  },
});

export const getCalendarEventsInRangeTool = createTool({
  id: "get-calendar-events-in-range",
  description: "Get calendar events within a specific date range from all connected providers (Google + Microsoft). Use this to see what's scheduled in a custom time period.",
  inputSchema: z.object({
    timeMin: z.string().describe("Start date/time in ISO 8601 format (e.g., '2024-02-12T00:00:00Z')"),
    timeMax: z.string().describe("End date/time in ISO 8601 format (e.g., '2024-02-12T23:59:59Z')"),
    provider: z.enum(['google', 'microsoft']).optional().describe("Optional: filter to specific provider"),
  }),
  outputSchema: z.object({
    events: z.array(z.object({
      id: z.string(),
      summary: z.string(),
      description: z.string().optional(),
      start: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
      }),
      end: z.object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
      }),
      location: z.string().optional(),
      attendees: z.array(z.any()).optional(),
      calendarId: z.string().optional(),
      calendarName: z.string().optional(),
      provider: z.enum(['google', 'microsoft']).optional(),
    })),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.getCalendarEventsInRange",
      {
        timeMin: inputData.timeMin,
        timeMax: inputData.timeMax,
        provider: inputData.provider,
      },
      { authToken, sessionId, userId }
    );

    return { events: data.events };
  },
});

export const findAvailableTimeSlotsTool = createTool({
  id: "find-available-time-slots",
  description: "Find available time slots in the user's calendar. Useful for scheduling new events. Specify date and work hours, returns free slots.",
  inputSchema: z.object({
    date: z.string().describe("Date to check in YYYY-MM-DD format"),
    startHour: z.number().min(0).max(23).default(9).describe("Start of work day (hour, 0-23)"),
    endHour: z.number().min(0).max(23).default(17).describe("End of work day (hour, 0-23)"),
    slotDurationMinutes: z.number().default(30).describe("Desired slot duration in minutes"),
  }),
  outputSchema: z.object({
    availableSlots: z.array(z.object({
      start: z.string(),
      end: z.string(),
      durationMinutes: z.number(),
    })),
    busySlots: z.array(z.object({
      start: z.string(),
      end: z.string(),
      summary: z.string(),
    })),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    // Get events for the specified date
    const dateObj = new Date(inputData.date);
    const startOfDay = new Date(dateObj);
    startOfDay.setHours(inputData.startHour, 0, 0, 0);

    const endOfDay = new Date(dateObj);
    endOfDay.setHours(inputData.endHour, 0, 0, 0);

    const { data } = await authenticatedTrpcCall(
      "mastra.getCalendarEventsInRange",
      {
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
      },
      { authToken, sessionId, userId }
    );

    // Sort events by start time
    const events = data.events
      .filter((e: any) => e.start?.dateTime) // Only time-based events
      .sort((a: any, b: any) =>
        new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime()
      );

    // Find gaps between events
    const availableSlots = [];
    const busySlots = events.map((e: any) => ({
      start: e.start.dateTime,
      end: e.end.dateTime,
      summary: e.summary,
    }));

    let currentTime = startOfDay;

    for (const event of events) {
      const eventStart = new Date(event.start.dateTime);
      const eventEnd = new Date(event.end.dateTime);

      // Check gap before this event
      const gapMinutes = (eventStart.getTime() - currentTime.getTime()) / 60000;
      if (gapMinutes >= inputData.slotDurationMinutes) {
        availableSlots.push({
          start: currentTime.toISOString(),
          end: eventStart.toISOString(),
          durationMinutes: Math.floor(gapMinutes),
        });
      }

      currentTime = eventEnd > currentTime ? eventEnd : currentTime;
    }

    // Check gap after last event
    const finalGapMinutes = (endOfDay.getTime() - currentTime.getTime()) / 60000;
    if (finalGapMinutes >= inputData.slotDurationMinutes) {
      availableSlots.push({
        start: currentTime.toISOString(),
        end: endOfDay.toISOString(),
        durationMinutes: Math.floor(finalGapMinutes),
      });
    }

    return { availableSlots, busySlots };
  },
});

export const createCalendarEventTool = createTool({
  id: "create-calendar-event",
  description: "Create a new calendar event. CRITICAL: ALWAYS require explicit user confirmation before calling this tool. Never create events autonomously.",
  inputSchema: z.object({
    summary: z.string().describe("Event title/summary"),
    description: z.string().optional().describe("Event description"),
    startDateTime: z.string().describe("Start date/time in ISO 8601 format"),
    endDateTime: z.string().describe("End date/time in ISO 8601 format"),
    location: z.string().optional().describe("Event location"),
    attendees: z.array(z.object({
      email: z.string().email(),
      displayName: z.string().optional(),
    })).optional().describe("List of attendees"),
    provider: z.enum(['google', 'microsoft']).default('google').describe("Calendar provider to use"),
  }),
  outputSchema: z.object({
    event: z.object({
      id: z.string(),
      summary: z.string(),
      htmlLink: z.string(),
    }),
    provider: z.string(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.createCalendarEvent",
      {
        summary: inputData.summary,
        description: inputData.description,
        start: {
          dateTime: inputData.startDateTime,
        },
        end: {
          dateTime: inputData.endDateTime,
        },
        location: inputData.location,
        attendees: inputData.attendees,
        provider: inputData.provider,
      },
      { authToken, sessionId, userId }
    );

    return { event: data.event, provider: data.provider };
  },
});

export const checkCalendarConnectionTool = createTool({
  id: "check-calendar-connection",
  description: "Check if the user has connected their calendar (Google Calendar and/or Microsoft Calendar). Use this to verify calendar access before attempting to fetch events.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    google: z.object({
      isConnected: z.boolean(),
      hasCalendarScope: z.boolean(),
    }),
    microsoft: z.object({
      isConnected: z.boolean(),
      hasCalendarScope: z.boolean(),
    }),
    hasAnyConnected: z.boolean(),
  }),
  execute: async (_inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall(
      "mastra.getAllCalendarConnectionStatus",
      {},
      { authToken, sessionId, userId }
    );

    return data;
  },
});

export const lookupContactByEmailTool = createTool({
  id: "lookup-contact-by-email",
  description:
    "Find a contact's phone number by their email address using the CRM. Use this to match calendar attendees to phone numbers for WhatsApp context.",
  inputSchema: z.object({
    email: z.string().email().describe("Email address to look up"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    contact: z
      .object({
        id: z.string(),
        firstName: z.string().nullable(),
        lastName: z.string().nullable(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
      })
      .optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { email } = inputData;

    console.log(`🔍 [lookupContactByEmail] Looking up contact for: ${email}`);

    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      console.error("❌ [lookupContactByEmail] No authentication token available");
      throw new Error("No authentication token available");
    }

    // tRPC v10 GET queries need input wrapped in {"json": ...}
    const input = JSON.stringify({ json: { email } });
    const { data: result } = await authenticatedTrpcQuery(
      `mastra.lookupContactByEmail?input=${encodeURIComponent(input)}`,
      { authToken, sessionId, userId }
    );

    if (result.found) {
      console.log(`✅ [lookupContactByEmail] Found contact: ${result.contact?.firstName} ${result.contact?.lastName}`);
    } else {
      console.log(`⚠️ [lookupContactByEmail] No contact found for ${email}`);
    }

    return result;
  },
});

export const getWhatsAppContextTool = createTool({
  id: "get-whatsapp-context",
  description:
    "Fetch recent WhatsApp messages with a contact for meeting context. IMPORTANT: Only use this AFTER the user explicitly confirms they want you to check their WhatsApp messages. Never fetch messages without user consent.",
  inputSchema: z.object({
    phoneNumber: z
      .string()
      .describe("Phone number in international format (e.g., +1234567890)"),
    contactName: z
      .string()
      .describe("Name of the contact for context in logs"),
    limit: z
      .number()
      .default(20)
      .describe("Number of recent messages to fetch (default: 20)"),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    messages: z
      .array(
        z.object({
          timestamp: z.string(),
          fromMe: z.boolean(),
          text: z.string(),
        })
      )
      .optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { phoneNumber, contactName, limit } = inputData;
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(
      `📱 [getWhatsAppContext] Fetching messages with ${contactName} (${phoneNumber})`
    );

    // Try persistent store first (has historical messages)
    const gateway = getWhatsAppGateway();
    const store = gateway?.getMessageStore();
    if (store && userId) {
      try {
        const jid = phoneNumber.replace(/[^\d]/g, '') + '@s.whatsapp.net';
        const history = await store.getChatHistory(userId, jid, { limit });
        if (history.messages.length > 0) {
          console.log(
            `✅ [getWhatsAppContext] Found ${history.messages.length} messages from persistent store`
          );
          return {
            found: true,
            messages: history.messages.map(m => ({
              timestamp: m.timestamp,
              fromMe: m.fromMe,
              text: m.text,
            })),
          };
        }
      } catch (error) {
        console.error(`⚠️ [getWhatsAppContext] Store query failed, falling back to cache:`, error);
      }
    }

    // Fallback to in-memory cache
    if (!sessionId) {
      console.error("❌ [getWhatsAppContext] No WhatsApp session ID available");
      return {
        found: false,
        error: "No WhatsApp session available. Please connect WhatsApp first.",
      };
    }

    if (!gateway) {
      console.error("❌ [getWhatsAppContext] WhatsApp gateway not available");
      return {
        found: false,
        error: "WhatsApp gateway not available",
      };
    }

    const result = gateway.fetchRecentMessages(sessionId, phoneNumber, limit);

    if (result.found) {
      console.log(
        `✅ [getWhatsAppContext] Found ${result.messages?.length || 0} messages with ${contactName}`
      );
    } else {
      console.log(
        `⚠️ [getWhatsAppContext] No messages found: ${result.error}`
      );
    }

    return result;
  },
});

export const createCrmContactTool = createTool({
  id: "create-crm-contact",
  description:
    "Save a new contact to the CRM. Use this after looking up a contact fails and the user provides their phone number AND confirms they want to save it. Always ask for confirmation before saving.",
  inputSchema: z.object({
    email: z.string().email().describe("Contact's email address"),
    phone: z.string().describe("Contact's phone number in international format (e.g., +1234567890)"),
    firstName: z.string().optional().describe("Contact's first name"),
    lastName: z.string().optional().describe("Contact's last name"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    created: z.boolean().optional(),
    updated: z.boolean().optional(),
    contactId: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { email, phone, firstName, lastName } = inputData;

    console.log(`💾 [createCrmContact] Saving contact: ${firstName} ${lastName} (${email}, ${phone})`);

    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      console.error("❌ [createCrmContact] No authentication token available");
      return { success: false, error: "No authentication token available" };
    }

    try {
      const { data: result } = await authenticatedTrpcCall<{
        created: boolean;
        updated: boolean;
        contactId?: string;
        error?: string;
      }>(
        "mastra.createCrmContact",
        { email, phone, firstName, lastName },
        { authToken, sessionId, userId }
      );

      if (result.created) {
        console.log(`✅ [createCrmContact] Created new contact: ${result.contactId}`);
        return { success: true, created: true, contactId: result.contactId };
      } else if (result.updated) {
        console.log(`✅ [createCrmContact] Updated existing contact with phone: ${result.contactId}`);
        return { success: true, updated: true, contactId: result.contactId };
      } else {
        console.log(`⚠️ [createCrmContact] ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (error) {
      console.error("❌ [createCrmContact] Error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create contact",
      };
    }
  },
});


// ==================== CRM TOOLS ====================

export const searchCrmContactsTool = createTool({
  id: "search-crm-contacts",
  description:
    "Search contacts in the CRM by name, tags, or organization. Returns a list of matching contacts with basic info. Use this to find contacts before getting full details or logging interactions.",
  inputSchema: z.object({
    search: z.string().optional().describe("Search by first or last name"),
    tags: z.array(z.string()).optional().describe("Filter by tags (e.g., ['investor', 'advisor'])"),
    organizationId: z.string().optional().describe("Filter by organization ID"),
    limit: z.number().default(20).describe("Max results to return (default: 20)"),
  }),
  outputSchema: z.object({
    contacts: z.array(z.object({
      id: z.string(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      tags: z.array(z.string()),
      organizationName: z.string().nullable(),
      organizationId: z.string().nullable(),
      connectionScore: z.number().nullable(),
      lastInteractionAt: z.string().nullable(),
      lastInteractionType: z.string().nullable(),
    })),
    nextCursor: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`🔍 [searchCrmContacts] Searching: ${inputData.search || "(all)"}, tags: ${inputData.tags?.join(", ") || "none"}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<{
      contacts: Array<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        email: string | null;
        phone: string | null;
        tags: string[];
        organizationName: string | null;
        organizationId: string | null;
        connectionScore: number | null;
        lastInteractionAt: string | null;
        lastInteractionType: string | null;
      }>;
      nextCursor?: string;
    }>(
      "mastra.searchCrmContacts",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [searchCrmContacts] Found ${data.contacts.length} contacts`);
    return data;
  },
});

export const getCrmContactTool = createTool({
  id: "get-crm-contact",
  description:
    "Get full details for a specific CRM contact including social handles, about, skills, and recent interactions. Use after searching to get complete info.",
  inputSchema: z.object({
    contactId: z.string().describe("The contact ID to look up"),
    includeInteractions: z.boolean().default(true).describe("Include recent interactions (default: true)"),
  }),
  outputSchema: z.object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    linkedIn: z.string().nullable(),
    telegram: z.string().nullable(),
    twitter: z.string().nullable(),
    github: z.string().nullable(),
    about: z.string().nullable(),
    skills: z.array(z.string()),
    tags: z.array(z.string()),
    organization: z.object({
      id: z.string(),
      name: z.string(),
      industry: z.string().nullable(),
    }).nullable(),
    connectionScore: z.number().nullable(),
    lastInteractionAt: z.string().nullable(),
    lastInteractionType: z.string().nullable(),
    interactions: z.array(z.object({
      id: z.string(),
      type: z.string(),
      direction: z.string(),
      subject: z.string().nullable(),
      notes: z.string().nullable(),
      createdAt: z.string(),
    })),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`📇 [getCrmContact] Getting contact: ${inputData.contactId}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<any>(
      "mastra.getCrmContact",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [getCrmContact] Got: ${data.firstName} ${data.lastName}`);
    return data;
  },
});

export const createFullCrmContactTool = createTool({
  id: "create-full-crm-contact",
  description:
    "Create a new contact in the CRM with full details including social handles, skills, tags, and organization. Always confirm with the user before creating.",
  inputSchema: z.object({
    firstName: z.string().optional().describe("Contact's first name"),
    lastName: z.string().optional().describe("Contact's last name"),
    email: z.string().email().optional().describe("Contact's email address"),
    phone: z.string().optional().describe("Phone number in international format"),
    linkedIn: z.string().optional().describe("LinkedIn profile URL"),
    telegram: z.string().optional().describe("Telegram username"),
    twitter: z.string().optional().describe("Twitter/X handle"),
    github: z.string().optional().describe("GitHub username"),
    about: z.string().optional().describe("Notes about this contact"),
    skills: z.array(z.string()).optional().describe("Contact's skills"),
    tags: z.array(z.string()).optional().describe("Tags for categorization"),
    organizationId: z.string().optional().describe("Organization to link this contact to"),
  }),
  outputSchema: z.object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`➕ [createFullCrmContact] Creating: ${inputData.firstName} ${inputData.lastName}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
    }>(
      "mastra.createFullCrmContact",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [createFullCrmContact] Created contact: ${data.id}`);
    return data;
  },
});

export const updateCrmContactTool = createTool({
  id: "update-crm-contact",
  description:
    "Update fields on an existing CRM contact. Only include fields you want to change. Set a field to null to clear it.",
  inputSchema: z.object({
    contactId: z.string().describe("The contact ID to update"),
    firstName: z.string().optional().describe("Updated first name"),
    lastName: z.string().optional().describe("Updated last name"),
    email: z.string().email().optional().nullable().describe("Updated email (null to clear)"),
    phone: z.string().optional().nullable().describe("Updated phone (null to clear)"),
    linkedIn: z.string().optional().nullable().describe("Updated LinkedIn URL"),
    telegram: z.string().optional().nullable().describe("Updated Telegram username"),
    twitter: z.string().optional().nullable().describe("Updated Twitter handle"),
    github: z.string().optional().nullable().describe("Updated GitHub username"),
    about: z.string().optional().describe("Updated notes"),
    skills: z.array(z.string()).optional().describe("Updated skills list (replaces existing)"),
    tags: z.array(z.string()).optional().describe("Updated tags list (replaces existing)"),
    organizationId: z.string().optional().nullable().describe("Organization ID (null to unlink)"),
  }),
  outputSchema: z.object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    updated: z.boolean(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`✏️ [updateCrmContact] Updating contact: ${inputData.contactId}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      updated: boolean;
    }>(
      "mastra.updateCrmContact",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [updateCrmContact] Updated: ${data.id}`);
    return data;
  },
});

export const addCrmInteractionTool = createTool({
  id: "add-crm-interaction",
  description:
    "Log an interaction with a CRM contact (email, call, meeting, note, etc.). This updates the contact's last interaction timestamp and creates an audit trail.",
  inputSchema: z.object({
    contactId: z.string().describe("The contact ID to log interaction for"),
    type: z.enum(["EMAIL", "PHONE_CALL", "MEETING", "NOTE", "LINKEDIN", "TELEGRAM", "OTHER"]).describe("Type of interaction"),
    direction: z.enum(["INBOUND", "OUTBOUND"]).describe("Direction: INBOUND (they reached out) or OUTBOUND (you reached out)"),
    subject: z.string().optional().describe("Brief subject line for the interaction"),
    notes: z.string().optional().describe("Detailed notes about the interaction"),
  }),
  outputSchema: z.object({
    id: z.string(),
    type: z.string(),
    direction: z.string(),
    subject: z.string().nullable(),
    createdAt: z.string(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`📝 [addCrmInteraction] Logging ${inputData.type} for contact: ${inputData.contactId}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<{
      id: string;
      type: string;
      direction: string;
      subject: string | null;
      createdAt: string;
    }>(
      "mastra.addCrmInteraction",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [addCrmInteraction] Logged interaction: ${data.id}`);
    return data;
  },
});

export const searchCrmOrganizationsTool = createTool({
  id: "search-crm-organizations",
  description:
    "Search organizations in the CRM by name or industry. Returns matching organizations with contact counts.",
  inputSchema: z.object({
    search: z.string().optional().describe("Search by organization name or description"),
    industry: z.string().optional().describe("Filter by industry"),
    limit: z.number().default(20).describe("Max results (default: 20)"),
  }),
  outputSchema: z.object({
    organizations: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      industry: z.string().nullable(),
      size: z.string().nullable(),
      websiteUrl: z.string().nullable(),
      contactCount: z.number(),
    })),
    nextCursor: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`🏢 [searchCrmOrganizations] Searching: ${inputData.search || "(all)"}, industry: ${inputData.industry || "any"}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<{
      organizations: Array<{
        id: string;
        name: string;
        description: string | null;
        industry: string | null;
        size: string | null;
        websiteUrl: string | null;
        contactCount: number;
      }>;
      nextCursor?: string;
    }>(
      "mastra.searchCrmOrganizations",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [searchCrmOrganizations] Found ${data.organizations.length} organizations`);
    return data;
  },
});

export const createCrmOrganizationTool = createTool({
  id: "create-crm-organization",
  description:
    "Create a new organization in the CRM. Confirm with the user before creating.",
  inputSchema: z.object({
    name: z.string().describe("Organization name"),
    description: z.string().optional().describe("Description of the organization"),
    websiteUrl: z.string().optional().describe("Website URL"),
    industry: z.string().optional().describe("Industry (e.g., 'Technology', 'Finance', 'Healthcare')"),
    size: z.enum(["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"]).optional().describe("Company size range"),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    industry: z.string().nullable(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    console.log(`🏢 [createCrmOrganization] Creating: ${inputData.name}`);

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    const { data } = await authenticatedTrpcCall<{
      id: string;
      name: string;
      industry: string | null;
    }>(
      "mastra.createCrmOrganization",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [createCrmOrganization] Created: ${data.id} (${data.name})`);
    return data;
  },
});

// Exponential knowledge base RAG tool
export const queryExponentialDocsTool = createTool({
  id: "query-exponential-docs",
  description:
    "Query the Exponential application knowledge base for information about its architecture, features, data model, integrations, and development patterns. Use this for any question about how the Exponential app works.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Question about the Exponential application"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        content: z.string(),
        section: z.string(),
        source: z.string(),
        type: z.string(),
        relevance: z.number(),
      })
    ),
  }),
  execute: async (inputData) => {
    return await queryExponentialDocs(inputData.query);
  },
});

const queryExponentialDocs = async (query: string) => {
  const vectorStore = new PgVector({
    id: "exponential-docs",
    connectionString: process.env.DATABASE_URL!,
    schemaName: "exponential_docs",
  });

  try {
    const { embedding } = await embed({
      model: openai.embedding("text-embedding-3-small"),
      value: query,
    });

    const results = await vectorStore.query({
      vectors: [embedding],
      topK: 5,
      indexName: "exponential_knowledge",
    });

    return {
      results: results.map((result) => ({
        content: result.metadata?.content || "",
        section: result.metadata?.section || "Unknown",
        source: result.metadata?.source || "Unknown",
        type: result.metadata?.type || "docs",
        relevance: result.score || 0,
      })),
    };
  } catch (error) {
    console.error("Error querying Exponential docs:", error);
    throw new Error(
      `Failed to query Exponential docs: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
};

// Notion tools
export { notionTools, notionSearchTool, notionGetPageTool, notionQueryDatabaseTool, notionCreatePageTool, notionUpdatePageTool } from "./notion-tools.js";

// Email tools
export { checkEmailConnectionTool, getRecentEmailsTool, getEmailByIdTool, searchEmailsTool, sendEmailTool, replyToEmailTool } from "./email-tools.js";

// OKR tools
export { getOkrObjectivesTool, createOkrObjectiveTool, updateOkrObjectiveTool, deleteOkrObjectiveTool, createOkrKeyResultTool, updateOkrKeyResultTool, deleteOkrKeyResultTool, checkInOkrKeyResultTool, getOkrStatsTool } from "./okr-tools.js";

// Project & Action management tools
export { createProjectTool, updateActionTool } from "./project-tools.js";

// WhatsApp search tools
export { listWhatsAppChatsTool, getWhatsAppChatHistoryTool, searchWhatsAppChatsTool } from "./whatsapp-tools.js";
