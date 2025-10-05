import TelegramBot from 'node-telegram-bot-api';
import { curationAgent } from '../agents/ostrom-agent.js';
import { createLogger } from '@mastra/core/logger';

const logger = createLogger({
  name: 'TelegramBot',
  level: 'info',
});

// Generate unique instance ID for tracking
const INSTANCE_ID = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
const PID = process.pid;

// Module-level logging
logger.info(`🚀 [${INSTANCE_ID}] [PID:${PID}] Telegram bot module loaded at ${new Date().toISOString()}`);

export class CurationTelegramBot {
  private bot!: TelegramBot; // Using definite assignment assertion since it's set in async constructor
  private instanceId: string;
  private retryCount: number = 0;
  private maxRetries: number = 3;
  private retryDelay: number = 5000; // 5 seconds

  constructor(token: string) {
    this.instanceId = `instance-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    logger.info(`🔧 [${INSTANCE_ID}] [PID:${PID}] Creating bot instance ${this.instanceId} at ${new Date().toISOString()}`);
    
    this.createBotWithRetry(token);
  }

  private async createBotWithRetry(token: string) {
    try {
      // First, try to clear any existing polling connections
      await this.clearExistingConnections(token);
      
      // Create bot with polling disabled initially
      this.bot = new TelegramBot(token, { polling: false });
      logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} created without polling`);
      
      // Setup event handlers first
      this.setupEventHandlers();
      
      // Then start polling with retry logic
      await this.startPollingWithRetry();
      
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} constructor failed:`, error);
      throw error;
    }
  }

  private async clearExistingConnections(token: string) {
    try {
      logger.info(`🧹 [${INSTANCE_ID}] [PID:${PID}] Clearing existing connections...`);
      
      // Try to get updates with offset -1 to clear pending updates
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`, {
        method: 'POST'
      });
      
      if (response.ok) {
        logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Cleared existing connections`);
      } else {
        logger.warn(`⚠️ [${INSTANCE_ID}] [PID:${PID}] Could not clear existing connections: ${response.status}`);
      }
    } catch (error) {
      logger.warn(`⚠️ [${INSTANCE_ID}] [PID:${PID}] Error clearing connections:`, error);
    }
  }

  private async startPollingWithRetry() {
    while (this.retryCount < this.maxRetries) {
      try {
        logger.info(`🔄 [${INSTANCE_ID}] [PID:${PID}] Starting polling attempt ${this.retryCount + 1}/${this.maxRetries}`);
        
        await this.bot.startPolling();
        logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} polling started successfully`);
        return; // Success!
        
      } catch (error: any) {
        this.retryCount++;
        
        if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
          logger.warn(`🔄 [${INSTANCE_ID}] [PID:${PID}] 409 Conflict detected on attempt ${this.retryCount}. Retrying in ${this.retryDelay}ms...`);
          
          if (this.retryCount < this.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
            this.retryDelay *= 2; // Exponential backoff
            continue;
          }
        }
        
        logger.error(`❌ [${INSTANCE_ID}] [PID:${PID}] Failed to start polling on attempt ${this.retryCount}:`, error);
        
        if (this.retryCount >= this.maxRetries) {
          throw new Error(`Max retries (${this.maxRetries}) exceeded for bot ${this.instanceId}`);
        }
      }
    }
  }

  private setupEventHandlers() {
    logger.info(`🎛️ [${INSTANCE_ID}] [PID:${PID}] Setting up event handlers for bot ${this.instanceId}`);
    
    // Handle all text messages
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const messageText = msg.text;

      // Only respond to text messages
      if (!messageText) {
        return;
      }

      logger.info(`📨 [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} received message from ${chatId}: ${messageText}`);

      try {
        // Show typing indicator
        await this.bot.sendChatAction(chatId, 'typing');

        // Send message to curation agent
        const response = await curationAgent.generate([
          {
            role: 'user',
            content: messageText,
          },
        ]);

        const agentResponse = response.text;

        if (agentResponse) {
          // Split long messages if they exceed Telegram's character limit
          await this.sendLongMessage(chatId, agentResponse);
          logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} sent response to ${chatId}`);
        } else {
          await this.bot.sendMessage(chatId, 'Sorry, I couldn\'t process your request. Please try again.');
          logger.warn(`⚠️ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} - empty response from agent`);
        }

      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} error processing message:`, error);
        await this.bot.sendMessage(
          chatId, 
          'Sorry, I encountered an error while processing your request. Please try again later.'
        );
      }
    });

    // Handle errors
    this.bot.on('error', (error) => {
      logger.error(`🚨 [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} error:`, error);
    });

    // Handle polling errors
    this.bot.on('polling_error', (error) => {
      logger.error(`🔄 [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} polling error:`, error);
    });

    logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} event handlers set up successfully`);
  }

  private async sendLongMessage(chatId: number, message: string) {
    const maxLength = 4096; // Telegram's character limit

    if (message.length <= maxLength) {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      return;
    }

    // Split message into chunks
    const chunks = this.splitMessage(message, maxLength);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const prefix = i === 0 ? '' : `(${i + 1}/${chunks.length}) `;
      
      try {
        await this.bot.sendMessage(chatId, prefix + chunk, { parse_mode: 'Markdown' });
      } catch (error) {
        // If markdown parsing fails, send as plain text
        logger.warn('Markdown parsing failed, sending as plain text');
        await this.bot.sendMessage(chatId, prefix + chunk);
      }
      
      // Small delay between messages to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  private splitMessage(message: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let currentChunk = '';

    // Split by lines first to try to preserve formatting
    const lines = message.split('\n');

    for (const line of lines) {
      // If a single line is longer than maxLength, we need to split it
      if (line.length > maxLength) {
        // Save current chunk if it exists
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // Split the long line
        const longLineChunks = this.splitLongLine(line, maxLength);
        chunks.push(...longLineChunks.slice(0, -1));
        currentChunk = longLineChunks[longLineChunks.length - 1];
      } else {
        // Check if adding this line would exceed the limit
        const testChunk = currentChunk + '\n' + line;
        if (testChunk.length > maxLength) {
          // Save current chunk and start a new one
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = line;
        } else {
          currentChunk = testChunk;
        }
      }
    }

    // Add the last chunk if it exists
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  private splitLongLine(line: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let currentPos = 0;

    while (currentPos < line.length) {
      const chunk = line.substring(currentPos, currentPos + maxLength);
      chunks.push(chunk);
      currentPos += maxLength;
    }

    return chunks;
  }

  public start() {
    logger.info(`🚀 [${INSTANCE_ID}] [PID:${PID}] Starting Telegram bot ${this.instanceId} polling...`);
    // Polling is already started in constructor, this is just for logging
  }

  public async stop() {
    logger.info(`🛑 [${INSTANCE_ID}] [PID:${PID}] Stopping Telegram bot ${this.instanceId}...`);
    try {
      if (this.bot) {
        await this.bot.stopPolling();
        logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} stopped successfully`);
      } else {
        logger.warn(`⚠️ [${INSTANCE_ID}] [PID:${PID}] Bot ${this.instanceId} was not initialized`);
      }
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] [PID:${PID}] Error stopping bot ${this.instanceId}:`, error);
    }
  }
}

// Global bot instance to prevent multiple instances
let globalBotInstance: CurationTelegramBot | null = null;

// Track creation attempts
let creationAttempts = 0;

// Export a function to create and start the bot
export function createTelegramBot(): CurationTelegramBot | null {
  creationAttempts++;
  const attemptId = `attempt-${creationAttempts}`;
  
  logger.info(`🔍 [${INSTANCE_ID}] [PID:${PID}] createTelegramBot called - ${attemptId} at ${new Date().toISOString()}`);
  
  // If bot already exists, return it (prevent duplicates)
  if (globalBotInstance) {
    logger.info(`♻️ [${INSTANCE_ID}] [PID:${PID}] Telegram bot already exists, reusing instance - ${attemptId}`);
    return globalBotInstance;
  }

  const token = process.env.CURATION_TELEGRAM_BOT_TOKEN;
  
  // Debug logging
  logger.info(`🔧 [${INSTANCE_ID}] [PID:${PID}] Environment variables check - ${attemptId}:`, {
    tokenExists: !!token,
    tokenLength: token?.length || 0,
    allEnvKeys: Object.keys(process.env).filter(key => key.includes('CURATION')),
    nodeEnv: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
  
  if (!token) {
    logger.warn(`⚠️ [${INSTANCE_ID}] [PID:${PID}] CURATION_TELEGRAM_BOT_TOKEN not found, Telegram bot will not start - ${attemptId}`);
    return null;
  }

  logger.info(`🚀 [${INSTANCE_ID}] [PID:${PID}] Initializing Telegram bot - ${attemptId}...`);
  
  try {
    globalBotInstance = new CurationTelegramBot(token);
    globalBotInstance.start();
    logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot created successfully - ${attemptId}`);
    return globalBotInstance;
  } catch (error) {
    logger.error(`❌ [${INSTANCE_ID}] [PID:${PID}] Failed to create bot - ${attemptId}:`, error);
    globalBotInstance = null;
    return null;
  }
}

// Add cleanup function for graceful shutdown
export async function cleanupTelegramBot(): Promise<void> {
  logger.info(`🧹 [${INSTANCE_ID}] [PID:${PID}] Cleanup requested at ${new Date().toISOString()}`);
  
  if (globalBotInstance) {
    logger.info(`🛑 [${INSTANCE_ID}] [PID:${PID}] Stopping existing bot instance...`);
    await globalBotInstance.stop();
    globalBotInstance = null;
    logger.info(`✅ [${INSTANCE_ID}] [PID:${PID}] Bot cleanup completed`);
  } else {
    logger.info(`ℹ️ [${INSTANCE_ID}] [PID:${PID}] No bot instance to cleanup`);
  }
}