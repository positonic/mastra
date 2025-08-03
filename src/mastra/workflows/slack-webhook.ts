import { Workflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { sendSlackMessageTool } from '../tools';
import { projectManagerAgent } from '../agents';

const processWithPaddy = {
  id: 'process-with-paddy',
  description: 'Process the message with Paddy agent',
  execute: async ({ context }: any) => {
    const triggerData = context?.getStepResult<{ text: string; channel: string; user: string; thread_ts?: string }>('trigger');
    
    if (!triggerData) {
      throw new Error('Trigger data not found');
    }
    
    // Execute with Paddy agent
    const response = await projectManagerAgent.text({
      prompt: triggerData.text,
    });
    
    return {
      text: triggerData.text,
      channel: triggerData.channel,
      user: triggerData.user,
      thread_ts: triggerData.thread_ts,
      response: response.text,
    };
  },
};

const sendSlackResponse = {
  id: 'send-slack-response',
  description: 'Send the response back to Slack',
  execute: async ({ context }: any) => {
    const paddyData = context?.getStepResult(processWithPaddy);
    
    if (!paddyData) {
      throw new Error('Paddy response data not found');
    }
    
    try {
      // Use the Slack tool to send the message
      const result = await sendSlackMessageTool.execute({
        channel: paddyData.channel,
        text: paddyData.response,
        blocks: undefined,
      });
      
      return {
        success: true,
        message: `Message sent to ${paddyData.channel}`,
        ts: result.ts,
      };
    } catch (error) {
      console.error('Failed to send Slack message:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

const slackWebhookWorkflow = new Workflow({
  name: 'slack-webhook',
  triggerSchema: z.object({
    text: z.string().describe('The message text from Slack'),
    channel: z.string().describe('The channel ID where the message was sent'),
    user: z.string().describe('The user ID who sent the message'),
    thread_ts: z.string().optional().describe('Thread timestamp if replying in thread'),
  }),
})
  .step(processWithPaddy)
  .then(sendSlackResponse);

slackWebhookWorkflow.commit();

export { slackWebhookWorkflow };