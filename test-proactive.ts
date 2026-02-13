import { triggerCheck } from './src/mastra/proactive/scheduler.js';

triggerCheck('evening')
  .then(() => {
    console.log('✅ Proactive check complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Check failed:', err);
    process.exit(1);
  });
