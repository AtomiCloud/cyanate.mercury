/**
 * Type definitions for the Web Generator SDK
 */

// Input from scraper
export interface ScraperOutput {
  structure: StructureData;
  schema: SchemaData;
  content: ContentData;
}

export interface StructureData {
  pages: PageStructure[];
}

export interface PageStructure {
  id: string;
  url: string;
  pagetype: string;
  title: string;
  references?: string[];
}

export interface SchemaData {
  [pageType: string]: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ContentData {
  pages: PageContent[];
}

export interface PageContent {
  id: string;
  url: string;
  pagetype: string;
  content: Record<string, unknown>;
}

// Design tokens extracted from reference site
export interface DesignTokens {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    foreground: string;
    muted: string;
    border: string;
  };
  typography: {
    fontFamily: string;
    fontSize: Record<string, string>;
    fontWeight: Record<string, number>;
  };
  spacing: Record<string, string>;
  borderRadius: Record<string, string>;
  shadows: Record<string, string>;
}

// Generator configuration
export interface GeneratorConfig {
  siteName: string;
  referenceUrl?: string;
  outputPath: string;
  scraperOutput: ScraperOutput;
  designTokens?: DesignTokens;
  /** Run quality checks using test-and-quality skill */
  runQualityChecks?: boolean;
}

// Generation result
export interface GenerationResult {
  success: boolean;
  outputPath: string;
  errors?: string[];
  warnings?: string[];
  validationPassed: boolean;
}
