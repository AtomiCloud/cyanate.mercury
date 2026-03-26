/**
 * Shared type definitions for the Web Generator SDK.
 */

// --- Scraper output types ---

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

// --- Design tokens ---

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

// --- Config types ---

export interface CuiConfig {
  /** Path to scraper output directory */
  input: string;
  /** Reference website URL for design extraction */
  reference?: string;
  /** Default env profile name (e.g., "claude" -> .env.claude) */
  profile: string;
  /** Per-step overrides keyed by step ID */
  steps?: Record<string, StepConfigOverride>;
}

export interface StepConfigOverride {
  profile?: string;
  env?: Record<string, string>;
  skip?: boolean;
}

// --- Run metadata ---

export interface RunMetadata {
  runId: string;
  status: 'running' | 'completed' | 'failed';
  config: CuiConfig;
  inputPath: string;
  referenceUrl?: string;
  profileName: string;
  runDir: string;
  createdAt: string;
  finishedAt?: string;
  completedSteps: string[];
  failedStep?: string;
  resumedFrom?: string;
}
