import { logger, LogTag } from "../../logger";
import { getEmbeddingProvider } from "../../rag/embedding";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "../../sticker-descriptions";
import { buildCachedStickerEmbeddingIndex } from "../../sticker-embedding-cache";
import type { StickerEmbeddingEntry } from "../../sticker-embedder";
import { loadUserStickerManifest } from "../../sticker-storage";

export interface EmbeddingIndexService {
  getStickerEmbeddingIndex(): StickerEmbeddingEntry[] | null;
  refreshStickerEmbeddingIndex(reason: string): void;
  invalidateStickerEmbeddingIndex(): void;
  scheduleStartupRefreshes(delayMs?: number): void;
}

export function createEmbeddingIndexService(): EmbeddingIndexService {
  let stickerEmbeddingIndex: StickerEmbeddingEntry[] | null = null;
  let stickerEmbeddingRefreshSeq = 0;

  function refreshStickerEmbeddingIndex(reason: string): void {
    const seq = ++stickerEmbeddingRefreshSeq;
    void (async () => {
      try {
        const provider = getEmbeddingProvider();
        if (!provider) {
          if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
          console.warn("[StickerEmbedding] Model not found. Sticker matching disabled.");
          return;
        }

        const index = await buildCachedStickerEmbeddingIndex(
          provider,
          BUILT_IN_STICKER_DESCRIPTIONS,
          loadUserStickerManifest(),
        );
        if (seq !== stickerEmbeddingRefreshSeq) return;
        stickerEmbeddingIndex = index;
        logger.info(LogTag.StickerEmbed, `index ready (${reason}): ${index.length} entries`);
      } catch (err) {
        if (seq === stickerEmbeddingRefreshSeq) stickerEmbeddingIndex = null;
        console.error("[StickerEmbedding] refresh failed:", err instanceof Error ? err.message : String(err));
      }
    })();
  }

  return {
    getStickerEmbeddingIndex: () => stickerEmbeddingIndex,
    refreshStickerEmbeddingIndex,
    invalidateStickerEmbeddingIndex: () => {
      stickerEmbeddingIndex = null;
    },
    scheduleStartupRefreshes: (delayMs = 1500) => {
      setTimeout(() => {
        refreshStickerEmbeddingIndex("startup");
      }, delayMs);
    },
  };
}
