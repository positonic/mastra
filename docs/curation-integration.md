# Curation Platform MCP Server Integration

This document provides comprehensive guidance for using the integrated Curation Platform MCP server within your Mastra AI project.

## Overview

The Curation Platform MCP server integration enables AI agents to access and analyze Curation Platform application data through the Model Context Protocol (MCP). This integration provides secure access to event applications, evaluations, scoring criteria, and analytics capabilities.

## Quick Start

### Prerequisites

1. **Authentication Token**: Obtain a client token from your Curation Platform administrator
2. **Event ID**: Valid UUID of the event you want to analyze
3. **Network Access**: Ensure access to `https://ftc-platform-mcp-production.up.railway.app`

### Setup

1. **Configure Authentication**:
   ```bash
   # Update your .env file
   CURATION_CLIENT_TOKEN="your_actual_secure_token_here"
   ```

2. **Verify Integration**:
   The Curation agent is automatically registered in your Mastra instance and ready to use.

3. **Test Connection**:
   ```typescript
   // The curationAgent will be available in your Mastra instance
   // Test with: Ask the Curation agent to test the connection
   ```

## Available Agents

### Curation Application Analyzer Agent

**Name**: `curationAgent`  
**Model**: Claude 3.5 Sonnet  
**Purpose**: Analyze Curation Platform applications and evaluations

**Capabilities**:
- Retrieve and analyze event applications
- Access evaluation criteria and scoring rubrics  
- Examine completed evaluations and scores
- Generate insights and recommendations
- Perform trend analysis across data

## MCP Tools Reference

### Connection Testing

#### `test_connection`
**Purpose**: Verify connectivity to the Curation Platform API  
**Parameters**: None  
**Returns**: Connection status and API health information

```typescript
// Usage in agent instructions:
"Use test_connection to verify API connectivity"
```

### Data Retrieval Tools

All data retrieval tools require a valid `eventId` parameter in UUID format.

#### `get_event_applications`
**Purpose**: Fetch all applications for a specific event  
**Parameters**: 
- `eventId` (string, UUID): The event identifier
**Returns**: Array of application objects with submission data

#### `get_event_evaluations` 
**Purpose**: Get completed evaluations with scores for an event
**Parameters**:
- `eventId` (string, UUID): The event identifier  
**Returns**: Array of evaluation objects with scoring data

#### `get_evaluation_criteria`
**Purpose**: Retrieve scoring criteria and rubrics for an event
**Parameters**:
- `eventId` (string, UUID): The event identifier
**Returns**: Evaluation criteria structure and scoring rubrics

#### `get_application_questions`
**Purpose**: Get the application question structure for an event
**Parameters**: 
- `eventId` (string, UUID): The event identifier
**Returns**: Application form structure and question definitions

## Usage Examples

### Basic Agent Interaction

```typescript
// Direct agent usage
const response = await mastra.agent('curationAgent').generate('Test the connection to Curation Platform API');

// Analyze applications for a specific event
const analysis = await mastra.agent('curationAgent').generate(
  'Analyze applications for event ID: 123e4567-e89b-12d3-a456-426614174000'
);
```

### Workflow Integration

The provided `analyzeApplicationsWorkflow` demonstrates comprehensive analysis:

```typescript
import { analyzeApplicationsWorkflow } from './workflows/curation-analysis-workflow';

// Trigger workflow
const result = await analyzeApplicationsWorkflow.trigger({
  eventId: '123e4567-e89b-12d3-a456-426614174000',
  analysisType: 'comprehensive',
  includeRecommendations: true
});
```

### Custom Analysis Requests

```typescript
// Quality analysis
await mastra.agent('curationAgent').generate(`
  Perform a quality analysis for event ${eventId}:
  1. Retrieve all applications
  2. Analyze completion rates
  3. Identify quality indicators
  4. Provide improvement recommendations
`);

// Scoring analysis  
await mastra.agent('curationAgent').generate(`
  Analyze evaluation scoring for event ${eventId}:
  1. Get evaluation criteria and completed evaluations
  2. Examine score distributions
  3. Identify scoring patterns
  4. Assess criteria effectiveness
`);
```

## Analysis Types

### Quality Analysis
- Application completeness assessment
- Response quality evaluation
- Missing information identification
- User experience insights

### Scoring Analysis  
- Score distribution analysis
- Inter-evaluator reliability
- Criteria effectiveness assessment
- Bias detection and analysis

### Trend Analysis
- Temporal patterns in applications
- Evaluation outcome trends  
- Process improvement opportunities
- Comparative analysis across events

### Comprehensive Analysis
- Combines all analysis types
- Cross-correlation insights
- End-to-end process evaluation
- Strategic recommendations

## Error Handling

### Common Issues and Solutions

**Connection Errors**:
```typescript
// If connection fails, verify:
1. CURATION_CLIENT_TOKEN is correctly set in .env
2. Network access to Railway production server  
3. Token permissions and validity
```

**Invalid Event ID**:
```typescript
// Ensure eventId is:
1. Valid UUID format (123e4567-e89b-12d3-a456-426614174000)
2. Exists in the Curation Platform
3. Accessible with your authentication token
```

**Rate Limiting**:
```typescript
// The MCP server includes rate limiting (100 requests per 15 minutes)
// If rate limited, wait and retry or implement request spacing
```

## Security Features

### Authentication
- **Bearer Token Authentication**: All requests require valid client token
- **Environment Variable Storage**: Tokens stored securely in .env file
- **Automatic Header Injection**: Authentication handled automatically

### Rate Limiting  
- **100 requests per 15-minute window** per IP address
- **Graceful Error Handling**: Clear rate limit messages
- **Standard Headers**: Rate limit info in response headers

### Data Privacy
- **No Data Storage**: MCP server doesn't store application data
- **Secure Transport**: All connections over HTTPS
- **Audit Logging**: Server-side request logging for security

## Monitoring and Debugging

### Health Monitoring
Check server status:
```bash
curl https://ftc-platform-mcp-production.up.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2025-10-05T11:01:07.109Z",
  "server": "ftc-platform-mcp",
  "version": "1.0.0", 
  "apiClient": {
    "configured": true,
    "baseUrl": "http://localhost:3000/api/mastra",
    "hasApiKey": true
  }
}
```

### Debug Mode
Enable debug logging in your Mastra development:
```bash
# Use the logging development command
bun run dev:log
```

### Common Debug Steps
1. **Test Connection**: Always start with `test_connection` tool
2. **Validate Event ID**: Ensure UUID format and existence
3. **Check Authentication**: Verify token in .env file
4. **Monitor Rate Limits**: Watch for rate limiting responses
5. **Review Network**: Ensure connectivity to Railway server

## Best Practices

### Performance Optimization
1. **Batch Requests**: Group related tool calls when possible
2. **Cache Results**: Store analysis results for repeated use
3. **Efficient Workflows**: Use workflow steps to organize complex analysis
4. **Rate Limit Awareness**: Space requests appropriately

### Data Analysis
1. **Start with Connection Test**: Always verify connectivity first
2. **Validate Input**: Check event IDs before making requests
3. **Comprehensive Retrieval**: Get all relevant data before analysis
4. **Structured Output**: Use consistent formatting for analysis results

### Error Recovery
1. **Graceful Degradation**: Handle partial data scenarios
2. **Retry Logic**: Implement appropriate retry strategies
3. **User Feedback**: Provide clear error messages and resolution steps
4. **Fallback Options**: Suggest alternative approaches when tools fail

## Development Environment

### Local Development
For local development, you can run the MCP server locally:

```bash
# Clone and set up local MCP server
git clone <ftc-platform-mcp-repo>
cd ftc-platform-mcp
npm install

# Configure environment
echo "VERCEL_API_BASE_URL=https://your-curation-platform.vercel.app/api/mastra" > .env
echo "MASTRA_API_KEY=your_api_key" >> .env
echo "MCP_CLIENT_TOKEN=your_secure_token_here" >> .env
echo "MCP_PORT=3030" >> .env

# Start local server
npm run dev
```

Then update agent configuration:
```typescript
// In curation-agent.ts for local development
mcpServers: [{
  name: 'curation-platform',
  url: 'http://localhost:3030/mcp',  // Local server
  transport: 'http',
  headers: {
    'Authorization': `Bearer ${process.env.CURATION_CLIENT_TOKEN}`
  }
}]
```

## Troubleshooting

### Connection Issues
| Problem | Solution |
|---------|----------|
| "Connection refused" | Check server URL and network connectivity |
| "Unauthorized" | Verify CURATION_CLIENT_TOKEN in .env file |
| "Rate limited" | Wait 15 minutes or space requests |
| "Invalid event ID" | Ensure UUID format and event exists |

### Data Issues  
| Problem | Solution |
|---------|----------|
| "No applications found" | Verify event has submitted applications |
| "Empty evaluation data" | Check if evaluations are completed |
| "Missing criteria" | Ensure evaluation criteria are configured |

### Integration Issues
| Problem | Solution |
|---------|----------|
| "Agent not found" | Verify curationAgent is exported and imported |
| "Tool not available" | Check MCP server configuration |
| "Environment variables" | Ensure .env file is loaded correctly |

## Support and Resources

### Technical Support
- **MCP Server Issues**: Check `/health` endpoint and server logs
- **Mastra Integration**: Refer to [Mastra Documentation](https://mastra.ai/en/docs)
- **Curation Platform API**: Contact your Curation Platform administrator

### Additional Resources
- **MCP Protocol**: [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- **Mastra Framework**: [Mastra Official Docs](https://mastra.ai/en/docs)
- **TypeScript Integration**: [Mastra TypeScript Guide](https://mastra.ai/en/docs/getting-started)

### Example Projects
- **Complete Integration**: See `src/mastra/workflows/curation-analysis-workflow.ts`
- **Agent Configuration**: See `src/mastra/agents/curation-agent.ts`
- **Environment Setup**: See `.env` configuration

This integration provides powerful AI-driven analysis capabilities for Curation Platform data while maintaining security, performance, and ease of use.