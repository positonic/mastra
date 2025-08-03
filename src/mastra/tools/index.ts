import { createTool } from '@mastra/core/tools';
import { PgVector } from '@mastra/pg';
import { openai } from '@ai-sdk/openai';
import { embed } from 'ai';
import { z } from 'zod';
import { WebClient } from '@slack/web-api';

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
    ema = (data[i] * multiplier) + (ema * (1 - multiplier));
  }
  
  return ema;
}

function calculateMovingAverages(candlesticks: CandlestickData[]): MovingAverages {
  const closes = candlesticks.map(c => c.close);
  
  return {
    EMA13: calculateEMA(closes, 13),
    EMA25: calculateEMA(closes, 25),
    EMA32: calculateEMA(closes, 32),
    MA100: calculateSMA(closes, 100),
    MA300: calculateSMA(closes, 300),
    EMA200: calculateEMA(closes, 200)
  };
}

export const binancePriceTool = createTool({
  id: 'get-binance-price',
  description: 'Get current price for a cryptocurrency pair from Binance',
  inputSchema: z.object({
    symbol: z.string().describe('Trading pair symbol (e.g., BTCUSDT, ETHUSDT)'),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    price: z.number(),
    priceString: z.string(),
  }),
  execute: async ({ context }) => {
    return await getBinancePrice(context.symbol);
  },
});

const getBinancePrice = async (symbol: string) => {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`;
  
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }
    
    const data = (await response.json()) as BinancePriceResponse;
    
    return {
      symbol: data.symbol,
      price: parseFloat(data.price),
      priceString: data.price,
    };
  } catch (error) {
    throw new Error(`Failed to fetch price for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

export const binanceCandlestickTool = createTool({
  id: 'get-binance-candlesticks',
  description: 'Get candlestick data for multiple timeframes and calculate moving averages for Pierre\'s trading analysis',
  inputSchema: z.object({
    symbol: z.string().describe('Trading pair symbol (e.g., BTCUSDT, ETHUSDT)'),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    currentPrice: z.number(),
    timeframes: z.object({
      daily: z.object({
        candlesticks: z.array(z.object({
          timestamp: z.number(),
          open: z.number(),
          high: z.number(),
          low: z.number(),
          close: z.number(),
          volume: z.number(),
        })),
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
        candlesticks: z.array(z.object({
          timestamp: z.number(),
          open: z.number(),
          high: z.number(),
          low: z.number(),
          close: z.number(),
          volume: z.number(),
        })),
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
        candlesticks: z.array(z.object({
          timestamp: z.number(),
          open: z.number(),
          high: z.number(),
          low: z.number(),
          close: z.number(),
          volume: z.number(),
        })),
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
  execute: async ({ context }) => {
    return await getCandlestickAnalysis(context.symbol);
  },
});

const getCandlestickAnalysis = async (symbol: string) => {
  const upperSymbol = symbol.toUpperCase();
  
  try {
    // Fetch candlestick data for all timeframes
    const [dailyData, fourHourData, oneHourData, priceData] = await Promise.all([
      fetchCandlesticks(upperSymbol, '1d', 500), // 500 days for MA300
      fetchCandlesticks(upperSymbol, '4h', 500), // 500 periods for MA300
      fetchCandlesticks(upperSymbol, '1h', 500), // 500 periods for MA300
      getBinancePrice(upperSymbol)
    ]);

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
    throw new Error(`Failed to fetch candlestick analysis for ${symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

const fetchCandlesticks = async (symbol: string, interval: string, limit: number): Promise<CandlestickData[]> => {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
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
  id: 'query-pierre-trading-system',
  description: 'Query Pierre\'s trading system knowledge base for trading advice and strategies',
  inputSchema: z.object({
    query: z.string().describe('Trading-related question or topic to search for'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      content: z.string(),
      section: z.string(),
      relevance: z.number(),
    })),
  }),
  execute: async ({ context }) => {
    return await queryPierreTradingSystem(context.query);
  },
});

const queryPierreTradingSystem = async (query: string) => {
  const vectorStore = new PgVector({
    connectionString: process.env.DATABASE_URL!,
    schemaName: 'pierre_docs',
  });

  try {
    const { embedding } = await embed({
      model: openai.embedding('text-embedding-3-small'),
      value: query,
    });

    const results = await vectorStore.query({
      vectors: [embedding],
      topK: 5,
      indexName: 'pierre_trading_system',
    });

    return {
      results: results.map(result => ({
        content: result.metadata?.content || '',
        section: result.metadata?.section || 'Unknown',
        relevance: result.score || 0,
      })),
    };
  } catch (error) {
    console.error('Error querying Pierre trading system:', error);
    throw new Error(`Failed to query trading system: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

export const weatherTool = createTool({
  id: 'get-weather',
  description: 'Get current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
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
  execute: async ({ context }) => {
    return await getWeather(context.location);
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
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return conditions[code] || 'Unknown';
}

// In your Mastra agent repo
import { Tool } from '@mastra/core/tools';

// Priority values constant for project management
export const PRIORITY_VALUES = ['Quick', 'Short', 'Long', 'Research'];

const TODO_APP_BASE_URL = process.env.TODO_APP_BASE_URL ||
 'http://localhost:3000';
const TODO_APP_API_KEY = process.env.TODO_APP_API_KEY; // For authentication

export const getProjectContextTool = new Tool({
  id: 'get-project-context',
  description: 'Get comprehensive project context including actions, goals, outcomes, and team members',
  inputSchema: z.object({
    projectId: z.string().describe('The project ID to get context for'),
  }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.string(),
      priority: z.string(),
      progress: z.number(),
      createdAt: z.string(),
      reviewDate: z.string().optional(),
      nextActionDate: z.string().optional(),
    }),
    actions: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().optional(),
    })),
    goals: z.array(z.object({
      id: z.number(),
      title: z.string(),
      description: z.string().optional(),
      dueDate: z.string().optional(),
      lifeDomain: z.object({
        title: z.string(),
        description: z.string().optional(),
      }),
    })),
    outcomes: z.array(z.object({
      id: z.string(),
      description: z.string(),
      type: z.string(),
      dueDate: z.string().optional(),
    })),
    teamMembers: z.array(z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      responsibilities: z.array(z.string()),
    })),
  }),
  async execute({ context }) {
    const { projectId } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.projectContext`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({ 
        json: { projectId },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get project context: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

export const getProjectActionsTool = new Tool({
  id: 'get-project-actions',
  description: 'Get all actions for a specific project with detailed status and priority information',
  inputSchema: z.object({
    projectId: z.string().describe('The project ID to get actions for'),
    status: z.enum(['ACTIVE', 'COMPLETED','CANCELLED']).optional().describe('Filter by action status'),
  }),
  outputSchema: z.object({
    actions: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().optional(),
      project: z.object({
        id: z.string(),
        name: z.string(),
        priority: z.string(),
      }),
    })),
  }),
  async execute({ context }) {
    const { projectId, status } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.projectActions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({ 
        json: { projectId, status },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get project actions: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

export const createProjectActionTool = new Tool({
  id: 'create-project-action',
  description: 'Create a new action for a project with specified priority and due date',
  inputSchema: z.object({
    projectId: z.string().describe('The project ID to create action for'),
    name: z.string().describe('The action name/title'),
    description: z.string().optional().describe('Detailed description of the action'),
    priority: z.enum(['Quick', 'Short', 'Long','Research']).describe('Action priority level'),
    dueDate: z.string().optional().describe('Due date in ISO format'),
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
  async execute({ context }) {
    const { projectId, name, description, priority, dueDate } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.createAction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({
        json: {
          projectId,
          name,
          description,
          priority,
          dueDate
        },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create action: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

export const updateProjectStatusTool = new Tool({
  id: 'update-project-status',
  description: 'Update project status and progress information',
  inputSchema: z.object({
    projectId: z.string().describe('The project ID to update'),
    status: z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).optional().describe('New project status'),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']).optional().describe('Project priority'),
    progress: z.number().min(0).max(100).optional().describe('Progress percentage (0-100)'),
    reviewDate: z.string().optional().describe('Next review date in ISO format'),
    nextActionDate: z.string().optional().describe('Next action date in ISO format'),
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
  async execute({ context }) {
    const { projectId, status, priority, progress, reviewDate, nextActionDate } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.updateProjectStatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({
        json: {
          projectId,
          status,
          priority,
          progress,
          reviewDate,
          nextActionDate
        },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update project: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

export const getProjectGoalsTool = new Tool({
  id: 'get-project-goals',
  description: 'Get all goals associated with a project and their alignment with life domains',
  inputSchema: z.object({
    projectId: z.string().describe('The project ID to get goals for'),
  }),
  outputSchema: z.object({
    goals: z.array(z.object({
      id: z.number(),
      title: z.string(),
      description: z.string().optional(),
      dueDate: z.string().optional(),
      lifeDomain: z.object({
        title: z.string(),
        description: z.string().optional(),
      }),
    })),
  }),
  async execute({ context }) {
    const { projectId } = context;
    // Get project context which includes goals
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.projectContext`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({ 
        json: { projectId },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get project goals: ${response.statusText}`);
    }

    const data = await response.json();
    // Extract just the goals from the project context response
    const contextData = data.result?.data || data;
    return { goals: contextData.goals || [] };
  },
});

// Initialize Slack Web Client
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

export const sendSlackMessageTool = createTool({
  id: 'send-slack-message',
  description: 'Send a message to a Slack channel or user',
  inputSchema: z.object({
    channel: z.string().describe('The channel ID or user ID to send the message to (e.g., C1234567890 or U1234567890)'),
    text: z.string().describe('The text content of the message'),
    blocks: z.array(z.record(z.any())).optional().describe('Optional Block Kit blocks for rich formatting'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string().describe('Timestamp of the message'),
    message: z.object({
      text: z.string(),
      type: z.string(),
      user: z.string(),
      ts: z.string(),
    }).optional(),
  }),
  execute: async ({ context }) => {
    const { channel, text, blocks } = context;
    try {
      const result = await slackClient.chat.postMessage({
        channel,
        text,
        blocks,
      });
      
      return {
        ok: result.ok || false,
        channel: result.channel || '',
        ts: result.ts || '',
        message: result.message ? {
          text: result.message.text || '',
          type: result.message.type || '',
          user: result.message.user || '',
          ts: result.message.ts || '',
        } : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to send Slack message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
});

export const updateSlackMessageTool = createTool({
  id: 'update-slack-message',
  description: 'Update an existing Slack message',
  inputSchema: z.object({
    channel: z.string().describe('The channel ID where the message was posted'),
    ts: z.string().describe('The timestamp of the message to update'),
    text: z.string().describe('The new text content of the message'),
    blocks: z.array(z.record(z.any())).optional().describe('Optional Block Kit blocks for rich formatting'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string(),
    text: z.string(),
  }),
  execute: async ({ context }) => {
    const { channel, ts, text, blocks } = context;
    try {
      const result = await slackClient.chat.update({
        channel,
        ts,
        text,
        blocks,
      });
      
      return {
        ok: result.ok || false,
        channel: result.channel || '',
        ts: result.ts || '',
        text: result.text || '',
      };
    } catch (error) {
      throw new Error(`Failed to update Slack message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
});

export const getSlackUserInfoTool = createTool({
  id: 'get-slack-user-info',
  description: 'Get information about a Slack user',
  inputSchema: z.object({
    user: z.string().describe('The user ID to get information for (e.g., U1234567890)'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    user: z.object({
      id: z.string(),
      name: z.string(),
      real_name: z.string().optional(),
      tz: z.string().optional(),
      tz_label: z.string().optional(),
      is_bot: z.boolean(),
      is_admin: z.boolean().optional(),
      is_owner: z.boolean().optional(),
    }).optional(),
  }),
  execute: async ({ context }) => {
    const { user } = context;
    try {
      const result = await slackClient.users.info({ user });
      
      if (!result.ok || !result.user) {
        return { ok: false };
      }
      
      return {
        ok: true,
        user: {
          id: result.user.id || '',
          name: result.user.name || '',
          real_name: result.user.real_name,
          tz: result.user.tz,
          tz_label: result.user.tz_label,
          is_bot: result.user.is_bot || false,
          is_admin: result.user.is_admin,
          is_owner: result.user.is_owner,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get Slack user info: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  },
});

export const getMeetingTranscriptionsTool = createTool({
  id: 'get-meeting-transcriptions',
  description: 'Get meeting transcriptions with filtering by project, date range, participants, or meeting type',
  inputSchema: z.object({
    projectId: z.string().optional().describe('Filter by specific project ID'),
    startDate: z.string().optional().describe('Start date filter in ISO format'),
    endDate: z.string().optional().describe('End date filter in ISO format'),
    participants: z.array(z.string()).optional().describe('Filter by participant names/IDs'),
    meetingType: z.string().optional().describe('Filter by meeting type (standup, planning, review, etc.)'),
    limit: z.number().optional().default(10).describe('Maximum number of transcriptions to return'),
  }),
  outputSchema: z.object({
    transcriptions: z.array(z.object({
      id: z.string(),
      title: z.string(),
      transcript: z.string(),
      participants: z.array(z.string()),
      meetingDate: z.string(),
      meetingType: z.string().optional(),
      projectId: z.string().optional(),
      duration: z.number().optional(),
      summary: z.string().optional(),
    })),
    total: z.number(),
  }),
  execute: async ({ context }) => {
    const { projectId, startDate, endDate, participants, meetingType, limit } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.getMeetingTranscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({ 
        json: { projectId, startDate, endDate, participants, meetingType, limit },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get meeting transcriptions: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

export const queryMeetingContextTool = createTool({
  id: 'query-meeting-context',
  description: 'Semantic search across meeting transcriptions to find decisions, action items, deadlines, and project discussions',
  inputSchema: z.object({
    query: z.string().describe('Search query for finding relevant meeting content'),
    projectId: z.string().optional().describe('Limit search to specific project'),
    dateRange: z.object({
      start: z.string(),
      end: z.string(),
    }).optional().describe('Date range to search within'),
    topK: z.number().optional().default(5).describe('Number of most relevant results to return'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      content: z.string(),
      meetingTitle: z.string(),
      meetingDate: z.string(),
      participants: z.array(z.string()),
      meetingType: z.string().optional(),
      projectId: z.string().optional(),
      relevanceScore: z.number(),
      contextType: z.enum(['decision', 'action_item', 'deadline', 'blocker', 'discussion', 'update']).optional(),
    })),
  }),
  execute: async ({ context }) => {
    const { query, projectId, dateRange, topK } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.queryMeetingContext`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({ 
        json: { query, projectId, dateRange, topK },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to query meeting context: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

export const getMeetingInsightsTool = createTool({
  id: 'get-meeting-insights',
  description: 'Extract key insights from recent meetings including decisions, action items, deadlines, and project evolution',
  inputSchema: z.object({
    projectId: z.string().optional().describe('Focus on specific project'),
    timeframe: z.enum(['last_week', 'last_month', 'last_quarter', 'custom']).default('last_week').describe('Time period for insights'),
    startDate: z.string().optional().describe('Custom start date if timeframe is custom'),
    endDate: z.string().optional().describe('Custom end date if timeframe is custom'),
    insightTypes: z.array(z.enum(['decisions', 'action_items', 'deadlines', 'blockers', 'milestones', 'team_updates'])).optional().describe('Types of insights to extract'),
  }),
  outputSchema: z.object({
    insights: z.object({
      decisions: z.array(z.object({
        decision: z.string(),
        context: z.string(),
        meetingDate: z.string(),
        participants: z.array(z.string()),
        impact: z.enum(['high', 'medium', 'low']).optional(),
      })),
      actionItems: z.array(z.object({
        action: z.string(),
        assignee: z.string().optional(),
        dueDate: z.string().optional(),
        status: z.enum(['pending', 'in_progress', 'completed']).optional(),
        meetingDate: z.string(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
      })),
      deadlines: z.array(z.object({
        deadline: z.string(),
        description: z.string(),
        dueDate: z.string(),
        owner: z.string().optional(),
        status: z.enum(['upcoming', 'overdue', 'completed']).optional(),
        meetingDate: z.string(),
      })),
      blockers: z.array(z.object({
        blocker: z.string(),
        impact: z.string(),
        owner: z.string().optional(),
        resolution: z.string().optional(),
        meetingDate: z.string(),
        severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
      })),
      milestones: z.array(z.object({
        milestone: z.string(),
        targetDate: z.string().optional(),
        progress: z.string().optional(),
        meetingDate: z.string(),
        status: z.enum(['planned', 'in_progress', 'achieved']).optional(),
      })),
      teamUpdates: z.array(z.object({
        member: z.string(),
        update: z.string(),
        category: z.enum(['progress', 'blocker', 'achievement', 'challenge']).optional(),
        meetingDate: z.string(),
      })),
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
  execute: async ({ context }) => {
    const { projectId, timeframe, startDate, endDate, insightTypes } = context;
    const response = await fetch(`${TODO_APP_BASE_URL}/api/trpc/mastra.getMeetingInsights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TODO_APP_API_KEY}`,
      },
      body: JSON.stringify({ 
        json: { projectId, timeframe, startDate, endDate, insightTypes },
        meta: {}
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get meeting insights: ${response.statusText}`);
    }

    const data = await response.json();
    return data.result?.data || data;
  },
});

