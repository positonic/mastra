import { pierreAgent } from './src/mastra/agents/index.js';

// Test the generalized Pierre agent with different crypto tickers

const testQueries = [
  // Test without ticker - should ask for one
  "What's the market outlook?",
  
  // Test with ETH
  "Can you analyze ETHUSDT for me?",
  
  // Test with SOL  
  "What do you think about SOLUSDT trend?",
  
  // Test with BTC
  "Give me the technical analysis for BTCUSDT"
];

async function testPierreAgent() {
  console.log('Testing generalized Pierre agent...\n');
  
  for (let i = 0; i < testQueries.length; i++) {
    console.log(`Test ${i + 1}: "${testQueries[i]}"`);
    
    try {
      const result = await pierreAgent.text(testQueries[i]);
      console.log('Response:', result.slice(0, 200) + '...\n');
    } catch (error) {
      console.log('Error:', error.message, '\n');
    }
  }
}

// Only run if this file is executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  testPierreAgent().catch(console.error);
}