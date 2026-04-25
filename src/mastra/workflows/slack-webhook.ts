import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { sendSlackMessageTool } from '../tools';
import { projectManagerAgent } from '../agents';

const processWithPaddy = createStep({
  id: 'process-with-paddy',
  description: 'Process the message with Paddy agent',
  inputSchema: z.object({
    text: z.string(),
    channel: z.string(),
    user: z.string(),
    thread_ts: z.string().optional(),
  }),
  outputSchema: z.object({
    text: z.string(),
    channel: z.string(),
    user: z.string(),
    thread_ts: z.string().optional(),
    response: z.string(),
  }),
  execute: async ({ inputData }) => {
    // Execute with Paddy agent
    const response = await projectManagerAgent.generate(inputData.text);

    return {
      text: inputData.text,
      channel: inputData.channel,
      user: inputData.user,
      thread_ts: inputData.thread_ts,
      response: response.text,
    };
  },
});

const sendSlackResponse = createStep({
  id: 'send-slack-response',
  description: 'Send the response back to Slack',
  inputSchema: z.object({
    text: z.string(),
    channel: z.string(),
    user: z.string(),
    thread_ts: z.string().optional(),
    response: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    ts: z.string().optional(),
  }),
  execute: async ({ inputData }) => {
    try {
      const exec = sendSlackMessageTool.execute;
      if (!exec) {
        return {
          success: false,
          message: 'sendSlackMessageTool.execute is undefined',
        };
      }

      // Use the Slack tool to send the message — pass empty ctx for workflow usage
      const emptyCtx = {} as never;
      const result = await exec(
        {
          channel: inputData.channel,
          text: inputData.response,
          blocks: undefined,
        },
        emptyCtx,
      );

      if ('error' in (result as Record<string, unknown>)) {
        return {
          success: false,
          message: 'Slack message returned validation error',
        };
      }

      const r = result as { ts: string };
      return {
        success: true,
        message: `Message sent to ${inputData.channel}`,
        ts: r.ts,
      };
    } catch (error) {
      console.error('Failed to send Slack message:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
});

export const slackWebhookWorkflow = createWorkflow({
  id: 'slack-webhook',
  inputSchema: z.object({
    text: z.string().describe('The message text from Slack'),
    channel: z.string().describe('The channel ID where the message was sent'),
    user: z.string().describe('The user ID who sent the message'),
    thread_ts: z.string().optional().describe('Thread timestamp if replying in thread'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    ts: z.string().optional(),
  }),
})
  .then(processWithPaddy)
  .then(sendSlackResponse)
  .commit();
