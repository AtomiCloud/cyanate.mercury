/**
 * Scraper output loader.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { ScraperOutput } from '../types.js';

export async function loadScraperOutput(inputPath: string): Promise<ScraperOutput> {
  const [structure, schema, content] = await Promise.all([
    readFile(join(inputPath, 'structure.json'), 'utf-8').then(JSON.parse),
    readFile(join(inputPath, 'schema.json'), 'utf-8').then(JSON.parse),
    readFile(join(inputPath, 'content.json'), 'utf-8').then(JSON.parse),
  ]);

  return { structure, schema, content };
}
