/**
 * Embedding model registry — frontend mirror of the backend's
 * `service/config/sub_config/general/embedding_config.py` EMBEDDING_MODELS.
 * provider → { model: dimension }.
 */

export const EMBEDDING_MODELS: Record<string, Record<string, number>> = {
  openai: {
    'text-embedding-3-large': 3072,
    'text-embedding-3-small': 1536,
    'text-embedding-ada-002': 1536,
  },
  google: {
    'gemini-embedding-001': 3072,
    'text-embedding-004': 768,
  },
};

export const EMBEDDING_PROVIDERS = Object.keys(EMBEDDING_MODELS);

export const DEFAULT_EMBEDDING_PROVIDER = 'openai';
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large';

export function modelsFor(provider: string): string[] {
  return Object.keys(EMBEDDING_MODELS[provider] ?? {});
}

export function dimensionOf(provider: string, model: string): number | null {
  return EMBEDDING_MODELS[provider]?.[model] ?? null;
}
