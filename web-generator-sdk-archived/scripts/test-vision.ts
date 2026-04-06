/**
 * Vision capability smoke test.
 *
 * Sends a tiny 1x1 red PNG to each model via the local proxy and checks
 * whether it gets a meaningful response (vision works) or an error (no vision).
 */

const BASE_URL = 'http://127.0.0.1:8317';
const API_KEY = '7e5387c8-f1ba-40fb-834a-87ee673b04f5';

// 1x1 red pixel PNG, base64-encoded (~68 bytes)
const RED_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const MODELS_TO_TEST = [
  // zai text
  { name: 'glm-4.5-air', id: 'glm-4.5-air' },
  { name: 'glm-4.7', id: 'glm-4.7' },
  { name: 'glm-5-turbo', id: 'glm-5-turbo' },
  // zai vision
  { name: 'glm-5v-turbo', id: 'glm-5v-turbo' },
  { name: 'glm-4.6v', id: 'glm-4.6v' },
  { name: 'glm-4.5v', id: 'glm-4.5v' },
  // codex / openai
  { name: 'gpt-5.1-codex-mini', id: 'gpt-5.1-codex-mini' },
  { name: 'gpt-5.4', id: 'gpt-5.4' },
  // claude
  { name: 'claude-sonnet-4-6', id: 'claude-sonnet-4-6' },
  { name: 'claude-haiku-4-5', id: 'claude-haiku-4-5-20251001' },
  // kimi
  { name: 'kimi-k2.5', id: 'kimi-k2.5' },
  // minimax
  { name: 'minimax-m2.7', id: 'minimax-m2.7' },
  // friendli variants
  { name: 'MiniMaxAI/MiniMax-M2.5', id: 'MiniMaxAI/MiniMax-M2.5' },
  { name: 'zai-org/GLM-4.7', id: 'zai-org/GLM-4.7' },
  { name: 'zai-org/GLM-5', id: 'zai-org/GLM-5' },
];

async function testModel(name: string, modelId: string): Promise<string> {
  const body = {
    model: modelId,
    max_tokens: 100,
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: 'image/png' as const,
              data: RED_PIXEL_PNG,
            },
          },
          {
            type: 'text' as const,
            text: 'What color is this image? Reply with just the color name.',
          },
        ],
      },
    ],
  };

  try {
    const resp = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return `FAIL (HTTP ${resp.status}): ${text.slice(0, 200)}`;
    }

    const json = await resp.json();
    const reply =
      json?.content?.[0]?.text ||
      json?.choices?.[0]?.message?.content ||
      JSON.stringify(json).slice(0, 200);
    return `VISION OK: "${reply.slice(0, 100)}"`;
  } catch (err: any) {
    return `ERROR: ${err.message?.slice(0, 150) || String(err)}`;
  }
}

async function main() {
  console.log('Testing vision capability across models via proxy...\n');
  console.log(`Proxy: ${BASE_URL}`);
  console.log(`Image: 1x1 red PNG (base64)\n`);
  console.log('─'.repeat(80));

  // Run 3 at a time to avoid overwhelming the proxy
  const results: Array<{ name: string; result: string }> = [];
  for (let i = 0; i < MODELS_TO_TEST.length; i += 3) {
    const batch = MODELS_TO_TEST.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(async (m) => {
        const result = await testModel(m.name, m.id);
        return { name: m.name, result };
      }),
    );
    results.push(...batchResults);
  }

  // Also try OpenAI-format image_url for models that might need it
  console.log('\n── Anthropic format (base64 source) ──\n');
  for (const r of results) {
    const icon = r.result.startsWith('VISION OK') ? '✅' : '❌';
    console.log(`${icon} ${r.name.padEnd(30)} ${r.result}`);
  }

  // Try OpenAI image_url format for a few key models
  console.log('\n── OpenAI format (image_url base64 data URI) ──\n');
  const oaiModels = [
    { name: 'glm-5v-turbo', id: 'glm-5v-turbo' },
    { name: 'gpt-5.4', id: 'gpt-5.4' },
    { name: 'gpt-5.1-codex-mini', id: 'gpt-5.1-codex-mini' },
    { name: 'kimi-k2.5', id: 'kimi-k2.5' },
    { name: 'claude-sonnet-4-6', id: 'claude-sonnet-4-6' },
  ];

  for (const m of oaiModels) {
    const body = {
      model: m.id,
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${RED_PIXEL_PNG}`,
              },
            },
            {
              type: 'text',
              text: 'What color is this image? Reply with just the color name.',
            },
          ],
        },
      ],
    };

    try {
      const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.log(`❌ ${m.name.padEnd(30)} FAIL (HTTP ${resp.status}): ${text.slice(0, 200)}`);
      } else {
        const json = await resp.json();
        const reply =
          json?.choices?.[0]?.message?.content ||
          json?.content?.[0]?.text ||
          JSON.stringify(json).slice(0, 200);
        console.log(`✅ ${m.name.padEnd(30)} VISION OK: "${reply.slice(0, 100)}"`);
      }
    } catch (err: any) {
      console.log(`❌ ${m.name.padEnd(30)} ERROR: ${err.message?.slice(0, 150)}`);
    }
  }
}

main();
