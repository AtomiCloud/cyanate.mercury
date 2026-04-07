/**
 * Content fetcher - abstracts data source
 *
 * Testing: reads from content.json (local file)
 * Production: reads from database (implement the same interface)
 */

import contentData from "../data/content.json";

export interface PageContent {
	url: string;
	pagetype: string;
	content: Record<string, unknown>;
}

export interface ContentData {
	pages: PageContent[];
}

/**
 * Get all pages
 */
export function getAllPages(): PageContent[] {
	const data = contentData as ContentData;
	return data.pages || [];
}

/**
 * Get page content by URL
 */
export function getPageByUrl(url: string): PageContent | undefined {
	const pages = getAllPages();
	return pages.find((page) => page.url === url);
}

/**
 * Get pages by pagetype
 */
export function getPagesByType(pagetype: string): PageContent[] {
	const pages = getAllPages();
	return pages.filter((page) => page.pagetype === pagetype);
}

/**
 * Get all unique pagetypes
 */
export function getPageTypes(): string[] {
	const pages = getAllPages();
	return [...new Set(pages.map((page) => page.pagetype))];
}
