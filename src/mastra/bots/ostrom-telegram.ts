import TelegramBot from 'node-telegram-bot-api';
import { curationAgent } from '../agents/ostrom-agent.js';
import { createLogger } from '@mastra/core/logger';

const logger = createLogger({
  name: 'TelegramBot',
  level: 'info',
});

export class CurationTelegramBot {
  private bot: TelegramBot;

  constructor(token: string) {
    this.bot = new TelegramBot(token, { polling: true });
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Handle all text messages
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const messageText = msg.text;

      // Only respond to text messages
      if (!messageText) {
        return;
      }

      logger.info(`Received message from ${chatId}: ${messageText}`);

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

        const agentResponse = response.content;

        if (agentResponse) {
          // Split long messages if they exceed Telegram's character limit
          await this.sendLongMessage(chatId, agentResponse);
        } else {
          await this.bot.sendMessage(chatId, 'Sorry, I couldn\'t process your request. Please try again.');
        }

      } catch (error) {
        logger.error('Error processing message:', error);
        await this.bot.sendMessage(
          chatId, 
          'Sorry, I encountered an error while processing your request. Please try again later.'
        );
      }
    });

    // Handle errors
    this.bot.on('error', (error) => {
      logger.error('Telegram bot error:', error);
    });

    // Handle polling errors
    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error);
    });

    logger.info('Telegram bot event handlers set up successfully');
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
    logger.info('Starting Telegram bot polling...');
    // Polling is already started in constructor, this is just for logging
  }

  public stop() {
    logger.info('Stopping Telegram bot...');
    this.bot.stopPolling();
  }
}

// Export a function to create and start the bot
export function createTelegramBot(): CurationTelegramBot | null {
  const token = process.env.CURATION_TELEGRAM_BOT_TOKEN;
  
  // Debug logging
  logger.info('Environment variables check:', {
    tokenExists: !!token,
    tokenLength: token?.length || 0,
    allEnvKeys: Object.keys(process.env).filter(key => key.includes('CURATION')),
  });
  
  if (!token) {
    logger.warn('CURATION_TELEGRAM_BOT_TOKEN not found, Telegram bot will not start');
    return null;
  }

  logger.info('Initializing Telegram bot...');
  const bot = new CurationTelegramBot(token);
  bot.start();
  return bot;
}