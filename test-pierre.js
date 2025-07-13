// Quick test for Pierre's enhanced functionality
async function testPierre() {
  const testQuery = {
    messages: [
      {
        role: 'user',
        content: "How are you today?"
      }
    ]
  };

  try {
    console.log('Testing Pierre with BTC market analysis...');
    
    const response = await fetch('http://localhost:4111/api/agents/pierreAgent/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testQuery)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    console.log('Pierre Response:');
    console.log('================');
    console.log(data);
    
  } catch (error) {
    console.error('Error testing Pierre:', error.message);
  }
}

testPierre();