# Setting up Paddy for Slack

## Prerequisites
1. Slack workspace where you have admin privileges
2. Mastra application running

## Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App"
3. Choose "From scratch"
4. Name your app "Paddy Project Manager"
5. Select your workspace

## Step 2: Configure Bot Permissions

1. Go to "OAuth & Permissions" in the sidebar
2. Under "Bot Token Scopes", add these scopes:
   - `chat:write` - Send messages
   - `chat:write.customize` - Override bot display name and icon per message (required for multi-agent identity)
   - `chat:write.public` - Send messages to channels without joining
   - `users:read` - View user info
   - `channels:read` - View channel info
   - `channels:history` - Read channel message history
   - `groups:read` - View private channel info
   - `groups:history` - Read private channel message history
   - `im:read` - View direct message info
   - `mpim:read` - View group direct message info
   - `mpim:history` - Read group DM message history

## Step 3: Install to Workspace

1. Go to "OAuth & Permissions"
2. Click "Install to Workspace"
3. Authorize the app
4. Copy the "Bot User OAuth Token" (starts with `xoxb-`)

## Step 4: Configure Environment Variables

Update your `.env` file with:
```
SLACK_BOT_TOKEN="xoxb-your-bot-token-here"
SLACK_SIGNING_SECRET="your-signing-secret"
SLACK_APP_TOKEN="xapp-your-app-token"
```

The signing secret can be found in "Basic Information" > "App Credentials"

## Step 5: Enable Socket Mode (Optional - for real-time events)

1. Go to "Socket Mode" in the sidebar
2. Enable Socket Mode
3. Generate an app-level token with `connections:write` scope
4. Copy the token (starts with `xapp-`)

## Step 6: Using Paddy in Slack

### Direct Message Usage
You can interact with Paddy through direct messages or by inviting it to channels.

### Example Commands
- "Get project status for PROJECT_ID"
- "Create a new action for PROJECT_ID: [action description]"
- "Show me all active tasks"
- "Update project PROJECT_ID status to IN_PROGRESS"

### Channel Usage
1. Invite Paddy to a channel: `/invite @Paddy`
2. Mention Paddy in messages: `@Paddy get project context for PROJECT_ID`

## Step 7: Connect Slack to Paddy

Since Mastra runs on port 4111, you can interact with Paddy directly through the API.

1. Start your Mastra application:
   ```bash
   npm run dev
   ```
   This will start Mastra on port 4111 with Paddy available at the `/api/agents/projectManagerAgent/text` endpoint

2. Expose your local server to the internet using ngrok:
   ```bash
   ngrok http 4111
   ```
   Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)

## Step 8: Set Up Slack Integration

You have several options to connect Slack to Paddy:

### Option A: Using Zapier/Make.com (Recommended)
1. Create a new automation
2. Trigger: "New message in Slack" (mention or DM)
3. Action: "HTTP Request" to your Mastra API
4. Configuration:
   - URL: `https://your-ngrok-url.ngrok.io/api/agents/projectManagerAgent/text`
   - Method: POST
   - Headers: `Content-Type: application/json`
   - Body:
   ```json
   {
     "prompt": "{{message_text}}"
   }
   ```
5. Add another action to send Paddy's response back to Slack

### Option B: Direct API Testing
Test Paddy directly with curl:

```bash
curl -X POST http://localhost:4111/api/agents/projectManagerAgent/text \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Get project status for PROJECT_ID"
  }'
```

### Option C: Custom Integration
If you have your own server, you can integrate like this:

```javascript
// When you receive a Slack message
const response = await fetch('https://your-ngrok-url.ngrok.io/api/agents/projectManagerAgent/text', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: slackMessage.text })
});

const paddyResponse = await response.json();

// Send Paddy's response back to Slack
await slackClient.chat.postMessage({
  channel: slackMessage.channel,
  text: paddyResponse.text
});
```

## Step 9: Testing the Integration

1. Run Mastra:
   ```bash
   npm run dev
   ```

2. Test Paddy directly:
   ```bash
   curl -X POST http://localhost:4111/api/agents/projectManagerAgent/text \
     -H "Content-Type: application/json" \
     -d '{
       "prompt": "Hello Paddy, can you help me with project management?"
     }'
   ```

3. You should see Paddy's response with project management guidance.

Example messages Paddy can handle:
- "Get project status for PROJECT_ID"  
- "Create a new action for PROJECT_ID: Update documentation"
- "Show me all active tasks"
- "Update project PROJECT_ID status to IN_PROGRESS"

## Troubleshooting

1. **Bot not responding**: Check that the bot token is correctly set in `.env`
2. **Permission errors**: Ensure all required scopes are added
3. **Connection issues**: Verify your Mastra app is running and accessible

## Advanced Features

### Using Slack Block Kit
Paddy supports rich formatting using Slack's Block Kit. The `sendSlackMessageTool` accepts a `blocks` parameter for advanced layouts.

### Updating Messages
Paddy can update previously sent messages using the `updateSlackMessageTool` with the message timestamp.

### User Information
Paddy can retrieve user information to personalize responses using the `getSlackUserInfoTool`.