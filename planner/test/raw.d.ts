// Ambient types for test only features (Vite raw imports, import.meta.glob, the URL class).
declare module '*?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob(pattern: string, options: { query?: string; import?: string; eager: true }): Record<string, unknown>;
}

declare class URL {
  constructor(url: string);
  readonly origin: string;
  readonly pathname: string;
  readonly searchParams: { get(name: string): string | null; has(name: string): boolean };
}
