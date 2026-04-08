import { config } from 'dotenv';
config({ path: '.env' });

console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY?.substring(0, 20) + '...');
console.log('ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL);
console.log('LLM_MODEL:', process.env.LLM_MODEL);
