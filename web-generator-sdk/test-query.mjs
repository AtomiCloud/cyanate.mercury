import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from 'dotenv';
config({ path: '.env' });

const result = query({
  prompt: 'Say hello',
  options: {
    systemPrompt: 'Test prompt',
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill', 'WebFetch'],
    cwd: process.cwd(),
    env: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
      LLM_MODEL: process.env.LLM_MODEL || '',
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
  }
});

for await (const message of result) {
  if (message.type === 'result') {
    console.log('Result:', message.result);
    break;
  }
}
