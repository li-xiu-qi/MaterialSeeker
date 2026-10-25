import { getDb, embeddingToBlob } from './db'
import { encodeBatch, embeddingEnabled, PASSAGE_INSTRUCTION, type EncodeRequest } from './embed'
import { composeCaptionText, loadTags } from './tags'

/**
 * 轻量期间新增的素材向量字段为 NULL。切回标准版后，旧向量仍可使用，
 * 但这些新素材需要一次显式回填，不能只靠下次重新入库来补救。
 *
 * 回填是显式动作而不是切换档位时自动执行：它要调用推理服务，素材多时成本
 * 与耗时都不小，不能在用户只想换个检索模式时悄悄跑一整库。
 */

export interface BackfillStats {
  textNotes: number
  chunks: number
  frameImages: number
  frameCaptions: number
  imageImages: number
  imageCaptions: number
  batches: number
}

interface FillTarget {
  table: 'text_notes' | 'chunks' | 'frames' | 'images'
  column: 'embedding' | 'caption_embedding'
  rows: Array<{ id: number; text?: string; path?: string; modality: 'text' | 'image' }>
}

function clampBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 16
  return Math.max(1, Math.min(50, Math.floor(value)))
}

interface CaptionSourceRow {
  id: number
  text: string | null
  tags_json: string | null
}

/** 与正常入库、编辑标注保持同一份语料：描述之外，当前标签也进入向量。 */
function withAssetTags(rows: CaptionSourceRow[]) {
  return rows
    .map((row) => ({
      id: row.id,
      text: composeCaptionText(row.text, loadTags(row.tags_json)),
      modality: 'text' as const,
    }))
    .filter((row) => row.text)
}

async function fill(target: FillTarget, batchSize: number): Promise<{ updated: number; batches: number }> {
  const db = getDb()
  let updated = 0
  let batches = 0
  for (let offset = 0; offset < target.rows.length; offset += batchSize) {
    const batch = target.rows.slice(offset, offset + batchSize)
    const inputs: EncodeRequest['inputs'] = batch.map((row) =>
      row.modality === 'image'
        ? { modality: 'image', path: row.path! }
        : { modality: 'text', text: row.text!, instruction: PASSAGE_INSTRUCTION },
    )
    const vectors = await encodeBatch({ inputs })
    if (vectors.length !== batch.length) {
      throw new Error(`encode mismatch: ${vectors.length} vectors for ${batch.length} rows`)
    }
    const update = db.prepare(
      `UPDATE ${target.table} SET ${target.column} = ? WHERE id = ? AND ${target.column} IS NULL`,
    )
    // 每批一个事务，避免中途失败时半批已经写、半批没写却仍被当成完成。
    // WHERE ... IS NULL 同时保证已有人工/后续任务写入的向量不会被覆盖。
    db.transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        updated += update.run(embeddingToBlob(vectors[i]), batch[i].id).changes
      }
    })()
    batches++
  }
  return { updated, batches }
}

export async function backfillEmbeddings(opts: { batchSize?: number } = {}): Promise<BackfillStats> {
  if (!embeddingEnabled()) {
    throw new Error('embedding backfill requires MATERIALSEEKER_PROFILE=standard')
  }
  const batchSize = clampBatchSize(opts.batchSize)
  const db = getDb()

  const textNotes = await fill(
    {
      table: 'text_notes',
      column: 'embedding',
      rows: withAssetTags(
        db
          .prepare(
            `SELECT tn.id, tn.content AS text, a.tags_json
             FROM text_notes tn JOIN assets a ON a.id = tn.asset_id
             WHERE tn.embedding IS NULL ORDER BY tn.id`,
          )
          .all() as CaptionSourceRow[],
      ),
    },
    batchSize,
  )
  const chunks = await fill(
    {
      table: 'chunks',
      column: 'embedding',
      rows: db
        .prepare('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id')
        .all()
        .map((r) => ({ ...(r as { id: number; text: string }), modality: 'text' as const })),
    },
    batchSize,
  )
  const frameImages = await fill(
    {
      table: 'frames',
      column: 'embedding',
      rows: db
        .prepare(
          "SELECT id, thumb_path AS path FROM frames WHERE embedding IS NULL AND thumb_path IS NOT NULL AND thumb_path != '' ORDER BY id",
        )
        .all()
        .map((r) => ({ ...(r as { id: number; path: string }), modality: 'image' as const })),
    },
    batchSize,
  )
  const frameCaptions = await fill(
    {
      table: 'frames',
      column: 'caption_embedding',
      rows: db
        .prepare(
          "SELECT id, caption AS text FROM frames WHERE caption_embedding IS NULL AND caption IS NOT NULL AND trim(caption) != '' ORDER BY id",
        )
        .all()
        .map((r) => ({ ...(r as { id: number; text: string }), modality: 'text' as const })),
    },
    batchSize,
  )
  const imageImages = await fill(
    {
      table: 'images',
      column: 'embedding',
      rows: db
        .prepare(
          "SELECT id, file_path AS path FROM images WHERE embedding IS NULL AND file_path IS NOT NULL AND file_path != '' ORDER BY id",
        )
        .all()
        .map((r) => ({ ...(r as { id: number; path: string }), modality: 'image' as const })),
    },
    batchSize,
  )
  const imageCaptions = await fill(
    {
      table: 'images',
      column: 'caption_embedding',
      rows: withAssetTags(
        db
          .prepare(
            `SELECT i.id, i.caption AS text, a.tags_json
             FROM images i JOIN assets a ON a.id = i.asset_id
             WHERE i.caption_embedding IS NULL ORDER BY i.id`,
          )
          .all() as CaptionSourceRow[],
      ),
    },
    batchSize,
  )

  return {
    textNotes: textNotes.updated,
    chunks: chunks.updated,
    frameImages: frameImages.updated,
    frameCaptions: frameCaptions.updated,
    imageImages: imageImages.updated,
    imageCaptions: imageCaptions.updated,
    batches:
      textNotes.batches +
      chunks.batches +
      frameImages.batches +
      frameCaptions.batches +
      imageImages.batches +
      imageCaptions.batches,
  }
}
