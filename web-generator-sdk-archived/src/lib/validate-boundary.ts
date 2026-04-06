/**
 * Runtime validation schemas for phase boundary data.
 *
 * Uses Zod to validate JSON structures flowing between phases.
 * Catches malformed data at read boundaries instead of letting it
 * propagate silently through the pipeline.
 */

import { z } from 'zod';
import type { InteractionManifest, ReducedMeta, Registry } from '../types.js';
import {
  formatSemanticIssues,
  validateInteractionManifest,
  validateReducedMetaSemantics,
  validateRegistrySemantics,
} from './semantics.js';

// --- Registry Schema ---

/** filterable_by can be a string, an array of strings, or an array of objects with field/listing/param */
const FilterableBySchema = z.union([
  z.string(),
  z.array(z.union([z.string(), z.object({}).passthrough()])),
]).optional().default('');

const CollectionDefSchema = z.object({
  source_pagetype: z.string().min(1),
  slug_field: z.string().min(1),
  listable_by: z.array(z.string()).optional().default([]),
  filterable_by: FilterableBySchema,
  slug_pattern: z.string().optional(),
  slug_extract: z.union([z.number(), z.string()]).optional(),
  search_fields: z.array(z.string()).optional(),
}).passthrough();

const StaticPageSchema = z.object({
  pagetype: z.string().min(1),
  route: z.string().min(1),
  layout: z.string().optional(),
});

const ListingQuerySchema = z.object({
  collection: z.string().optional(),
  filter: z.string().optional(),
}).passthrough();

const ListingDefSchema = z.object({
  route: z.string().min(1),
  queries: z.array(ListingQuerySchema).default([]),
  paginated: z.boolean().optional().default(false),
  searchable: z.boolean().optional(),
  search_fields: z.array(z.string()).optional(),
}).passthrough();

/** layouts can be an array or an object keyed by layout name */
const LayoutItemSchema = z.object({
  description: z.string().optional(),
  page_types: z.array(z.string()),
}).passthrough();

export const RegistrySchema = z.object({
  layouts: z.union([
    z.array(LayoutItemSchema).min(1, 'Registry must have at least one layout'),
    z.record(z.string(), LayoutItemSchema),
  ]),
  collections: z.union([
    z.record(z.string(), CollectionDefSchema),
    z.array(CollectionDefSchema.extend({ name: z.string().optional(), id: z.string().optional() })),
  ]),
  static_pages: z.array(StaticPageSchema).default([]),
  listings: z.record(z.string(), ListingDefSchema).optional().default({}),
  navigation: z.object({}).passthrough().optional(),
}).passthrough();

// --- Reduced Meta Schema ---

export const ReducedMetaSchema = z.object({
  source: z.object({
    total_pages: z.number().int().positive(),
    page_types: z.number().int().positive(),
    site_url: z.string().min(1, 'site_url must not be empty'),
    scraped_at: z.string().optional(),
  }),
  global_keys: z.array(z.string()),
  page_types: z.array(z.object({
    pagetype: z.string().min(1),
    route: z.string(),
    count: z.number().int().positive(),
    multi: z.boolean(),
  }).passthrough()),
}).passthrough();

// --- Design Tokens Schema ---

export const DesignTokensSchema = z.object({
  atomic: z.object({}).passthrough(),
  gradients: z.object({}).passthrough(),
  layout: z.object({}).passthrough(),
  componentSpacing: z.object({}).passthrough(),
  motion: z.object({}).passthrough(),
  surfaces: z.object({}).passthrough(),
  visualIdentity: z.object({}).passthrough(),
}).passthrough();

export const InteractionPatternSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['fragment', 'modal', 'accordion', 'tabs', 'search', 'filter', 'form', 'popup', 'other']),
  trigger: z.string().optional(),
  target: z.string().optional(),
  pageType: z.string().optional(),
  route: z.string().optional(),
  description: z.string().min(1),
}).passthrough();

export const InteractionManifestSchema = z.object({
  patterns: z.array(InteractionPatternSchema).default([]),
  pages: z.array(z.object({
    route: z.string().min(1),
    ids: z.array(z.string()).default([]),
    triggers: z.array(z.string()).default([]),
  })).default([]),
}).passthrough();

// --- Validation helpers ---

export function validateRegistry(data: unknown): z.infer<typeof RegistrySchema> {
  return RegistrySchema.parse(data);
}

export function validateRegistryWithMeta(data: unknown, meta: ReducedMeta): Registry {
  const parsed = RegistrySchema.parse(data) as unknown as Registry;
  const issues = validateRegistrySemantics(parsed, meta);
  if (issues.length > 0) {
    throw new Error(formatSemanticIssues('Registry semantic validation failed', issues));
  }
  return parsed;
}

export function validateReducedMeta(data: unknown): z.infer<typeof ReducedMetaSchema> {
  return ReducedMetaSchema.parse(data);
}

export function validateReducedMetaStrict(data: unknown): ReducedMeta {
  const parsed = ReducedMetaSchema.parse(data) as unknown as ReducedMeta;
  const issues = validateReducedMetaSemantics(parsed);
  if (issues.length > 0) {
    throw new Error(formatSemanticIssues('Reduced meta semantic validation failed', issues));
  }
  return parsed;
}

export function validateDesignTokens(data: unknown): z.infer<typeof DesignTokensSchema> {
  return DesignTokensSchema.parse(data);
}

export function validateInteractionManifestData(data: unknown, registry?: Registry): InteractionManifest {
  const parsed = InteractionManifestSchema.parse(data) as unknown as InteractionManifest;
  const issues = validateInteractionManifest(parsed, registry);
  if (issues.length > 0) {
    throw new Error(formatSemanticIssues('Interaction manifest validation failed', issues));
  }
  return parsed;
}
