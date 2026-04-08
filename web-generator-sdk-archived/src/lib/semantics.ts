import { readFile } from 'fs/promises';
import { join } from 'path';
import type { InteractionManifest, InteractionPattern, ReducedMeta, Registry } from '../types.js';

export interface SemanticIssue {
  path: string;
  message: string;
}

function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  if (!trimmed) return '/';
  try {
    return (new URL(trimmed).pathname || '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  } catch {
    return trimmed.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  }
}

function getSchemaKeysForPagetype(meta: ReducedMeta, pagetype: string): Set<string> {
  const pageType = meta.page_types.find((entry) => entry.pagetype === pagetype);
  return new Set([...(pageType?.schema_keys || []), ...(pageType?.own_keys || [])]);
}

function hasFieldEvidence(meta: ReducedMeta, pagetype: string): boolean {
  const pageType = meta.page_types.find((entry) => entry.pagetype === pagetype);
  return Boolean((pageType?.schema_keys?.length || 0) > 0 || (pageType?.own_keys?.length || 0) > 0);
}

export function validateReducedMetaSemantics(meta: ReducedMeta): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const pageTypes = meta.page_types || [];
  const names = new Set<string>();
  const routes = new Set<string>();
  const total = pageTypes.reduce((sum, entry) => sum + entry.count, 0);

  if (meta.source.page_types !== pageTypes.length) {
    issues.push({ path: 'source.page_types', message: `Expected ${pageTypes.length}, got ${meta.source.page_types}` });
  }
  if (total !== meta.source.total_pages) {
    issues.push({ path: 'source.total_pages', message: `Sum of page type counts ${total} does not equal source total ${meta.source.total_pages}` });
  }

  for (const entry of pageTypes) {
    if (names.has(entry.pagetype)) {
      issues.push({ path: `page_types.${entry.pagetype}`, message: 'Duplicate pagetype' });
    }
    names.add(entry.pagetype);

    const normalizedRoute = normalizeRoute(entry.route);
    if (routes.has(normalizedRoute)) {
      issues.push({ path: `page_types.${entry.pagetype}.route`, message: `Duplicate normalized route ${normalizedRoute}` });
    }
    routes.add(normalizedRoute);

    if (entry.multi !== (entry.count > 1)) {
      issues.push({ path: `page_types.${entry.pagetype}.multi`, message: `Expected multi=${entry.count > 1} based on count ${entry.count}` });
    }

    if (normalizedRoute.includes('[') && !entry.slug_param) {
      issues.push({ path: `page_types.${entry.pagetype}.slug_param`, message: 'Dynamic route missing slug_param' });
    }
  }

  return issues;
}

export function validateRegistrySemantics(registry: Registry, meta: ReducedMeta): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const pagetypeMap = new Map(meta.page_types.map((entry) => [entry.pagetype, entry]));
  const coverage = new Map<string, string[]>();
  const normalizedRoutes = new Map<string, string>();

  const markCoverage = (pagetype: string, source: string) => {
    const list = coverage.get(pagetype) || [];
    list.push(source);
    coverage.set(pagetype, list);
  };

  for (const [layoutName, layout] of Object.entries(registry.layouts || {})) {
    for (const pagetype of layout.page_types || []) {
      if (!pagetypeMap.has(pagetype)) {
        issues.push({ path: `layouts.${layoutName}.page_types`, message: `Unknown pagetype ${pagetype}` });
      }
    }
  }

  for (const [collectionName, collection] of Object.entries(registry.collections || {})) {
    const source = pagetypeMap.get(collection.source_pagetype);
    if (!source) {
      issues.push({ path: `collections.${collectionName}.source_pagetype`, message: `Unknown pagetype ${collection.source_pagetype}` });
      continue;
    }
    if (!source.multi) {
      issues.push({ path: `collections.${collectionName}.source_pagetype`, message: `Pagetype ${collection.source_pagetype} is not multi-instance` });
    }
    markCoverage(collection.source_pagetype, `collection:${collectionName}`);

    const schemaKeys = getSchemaKeysForPagetype(meta, collection.source_pagetype);
    const fieldEvidenceAvailable = hasFieldEvidence(meta, collection.source_pagetype);
    const slugFieldIsVirtualUrl = collection.slug_field === 'url';
    if (fieldEvidenceAvailable && !slugFieldIsVirtualUrl && !schemaKeys.has(collection.slug_field)) {
      issues.push({ path: `collections.${collectionName}.slug_field`, message: `Unknown slug field ${collection.slug_field}` });
    }
    if (fieldEvidenceAvailable) {
      for (const searchField of collection.search_fields || []) {
        if (!schemaKeys.has(searchField)) {
          issues.push({ path: `collections.${collectionName}.search_fields`, message: `Unknown search field ${searchField}` });
        }
      }
    }
  }

  for (const staticPage of registry.static_pages || []) {
    const source = pagetypeMap.get(staticPage.pagetype);
    if (!source) {
      issues.push({ path: `static_pages.${staticPage.route}`, message: `Unknown pagetype ${staticPage.pagetype}` });
    } else if (source.multi) {
      issues.push({ path: `static_pages.${staticPage.route}`, message: `Pagetype ${staticPage.pagetype} is multi-instance and should not be static` });
    }
    markCoverage(staticPage.pagetype, `static:${staticPage.route}`);

    const route = normalizeRoute(staticPage.route);
    if (normalizedRoutes.has(route)) {
      issues.push({ path: `static_pages.${staticPage.route}`, message: `Route collides with ${normalizedRoutes.get(route)}` });
    }
    normalizedRoutes.set(route, `static:${staticPage.route}`);
  }

  for (const [listingName, listing] of Object.entries(registry.listings || {})) {
    if (pagetypeMap.has(listingName)) {
      markCoverage(listingName, `listing:${listingName}`);
    }

    const route = normalizeRoute(listing.route);
    if (normalizedRoutes.has(route)) {
      issues.push({ path: `listings.${listingName}.route`, message: `Route collides with ${normalizedRoutes.get(route)}` });
    }
    normalizedRoutes.set(route, `listing:${listingName}`);

    for (const query of listing.queries || []) {
      if (!query.collection || !registry.collections[query.collection]) {
        issues.push({ path: `listings.${listingName}.queries`, message: `Unknown collection ${query.collection || '(missing)'}` });
        continue;
      }
      const collection = registry.collections[query.collection];
      const schemaKeys = getSchemaKeysForPagetype(meta, collection.source_pagetype);
      const fieldEvidenceAvailable = hasFieldEvidence(meta, collection.source_pagetype);
      const filterIsVirtualUrl = query.filter_by_param === 'url';
      if (fieldEvidenceAvailable && query.filter_by_param && !filterIsVirtualUrl && !schemaKeys.has(query.filter_by_param)) {
        issues.push({ path: `listings.${listingName}.queries`, message: `Unknown filter_by_param ${query.filter_by_param}` });
      }
    }

    for (const searchField of listing.search_fields || []) {
      const referencedCollections = (listing.queries || []).map((query) => query.collection).filter(Boolean) as string[];
      const collectionsWithEvidence = referencedCollections
        .map((collectionName) => registry.collections[collectionName])
        .filter((collection): collection is Registry['collections'][string] => Boolean(collection && hasFieldEvidence(meta, collection.source_pagetype)));
      if (collectionsWithEvidence.length === 0) {
        continue;
      }
      const valid = collectionsWithEvidence.some((collection) => getSchemaKeysForPagetype(meta, collection.source_pagetype).has(searchField));
      if (!valid) {
        issues.push({ path: `listings.${listingName}.search_fields`, message: `Unknown search field ${searchField}` });
      }
    }
  }

  for (const pagetype of pagetypeMap.keys()) {
    const entries = coverage.get(pagetype) || [];
    if (entries.length === 0) {
      issues.push({ path: `coverage.${pagetype}`, message: 'Pagetype is not represented in collections, listings, or static pages' });
    } else if (entries.length > 1) {
      issues.push({ path: `coverage.${pagetype}`, message: `Pagetype appears in multiple places: ${entries.join(', ')}` });
    }
  }

  return issues;
}

function normalizeInteractionPattern(pattern: InteractionPattern): InteractionPattern {
  return {
    ...pattern,
    id: pattern.id.trim(),
    trigger: pattern.trigger?.trim(),
    target: pattern.target?.trim(),
    route: pattern.route ? normalizeRoute(pattern.route) : undefined,
    description: pattern.description.trim(),
  };
}

function routePatternToRegex(route: string): RegExp {
  const normalized = normalizeRoute(route);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\\\[[^\]]+\\\]/g, '[^/]+');
  return new RegExp(`^${pattern}$`);
}

function buildCollectionRouteMatchers(registry: Registry): Array<{ pagetype: string; regex: RegExp }> {
  return Object.values(registry.collections || {}).map((collection) => {
    let route = collection.slug_pattern;
    if (!route && collection.slug_field === 'url') {
      route = collection.slug_extract === 'last_path_segment' ? '/[slug]' : '/[slug]';
    }
    return {
      pagetype: collection.source_pagetype,
      regex: routePatternToRegex(route || '/[slug]'),
    };
  });
}

export function validateInteractionManifest(manifest: InteractionManifest, registry?: Registry): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const ids = new Set<string>();
  const collectionRouteMatchers = registry ? buildCollectionRouteMatchers(registry) : [];

  for (const pattern of manifest.patterns || []) {
    const normalized = normalizeInteractionPattern(pattern);
    if (!normalized.id) {
      issues.push({ path: 'patterns', message: 'Pattern id must not be empty' });
    }
    if (ids.has(normalized.id)) {
      issues.push({ path: `patterns.${normalized.id}`, message: 'Duplicate interaction pattern id' });
    }
    ids.add(normalized.id);

    if ((normalized.type === 'fragment' || normalized.trigger?.startsWith('#')) && !normalized.target && !normalized.trigger) {
      issues.push({ path: `patterns.${normalized.id}`, message: 'Fragment-like pattern must define a trigger or target' });
    }
    if (normalized.route && registry) {
      const collectionOwnsPageType = normalized.pageType
        ? Object.values(registry.collections || {}).some((collection) => collection.source_pagetype === normalized.pageType)
        : false;
      const routeExists = (registry.static_pages || []).some((entry) => normalizeRoute(entry.route) === normalized.route)
        || Object.values(registry.listings || {}).some((listing) => routePatternToRegex(listing.route).test(normalized.route!))
        || collectionRouteMatchers.some((matcher) => (!normalized.pageType || matcher.pagetype === normalized.pageType) && matcher.regex.test(normalized.route!))
        || collectionOwnsPageType;
      if (!routeExists) {
        issues.push({ path: `patterns.${normalized.id}.route`, message: `Route ${normalized.route} does not appear in the registry` });
      }
    }
  }

  for (const page of manifest.pages || []) {
    const route = normalizeRoute(page.route);
    const pageIds = new Set<string>();
    for (const id of page.ids || []) {
      if (pageIds.has(id)) {
        issues.push({ path: `pages.${route}.ids`, message: `Duplicate id ${id}` });
      }
      pageIds.add(id);
    }
  }

  return issues;
}

export function formatSemanticIssues(title: string, issues: SemanticIssue[]): string {
  if (issues.length === 0) return `${title}: OK`;
  return `${title}:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`;
}

export async function loadReducedMetaFromDir(workingDir: string): Promise<ReducedMeta> {
  return JSON.parse(await readFile(join(workingDir, 'output/reduced/meta.json'), 'utf-8')) as ReducedMeta;
}

export async function loadRegistryFromDir(workingDir: string): Promise<Registry> {
  return JSON.parse(await readFile(join(workingDir, 'output/reduced/registry.json'), 'utf-8')) as Registry;
}
