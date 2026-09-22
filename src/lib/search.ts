/**
 * 检索层。四路加权合并：
 *
 * 1. frames.embedding          帧本身的向量
 * 2. frames.caption_embedding  帧描述文本的向量
 * 3. chunks.embedding          逐字稿块的向量
 * 4. images.embedding          入库图片的向量
 *
 * 首版按等权起步（PRD 开放问题 5）。权重无实测依据，调参需要一批真实
 * 查询做样本，在那之前任何权重都是拍的。
 *
 * 向量查询走暴力余弦（全表扫描 + JS 计算），不用 sqlite-vec 的 ANN。
 * 个人库规模（万级帧）下暴力足够，ANN 的召回损失不值得。
 */

import { getDb, cosineSim, blobToEmbedding, embeddingToBlob, VECTOR_DIM } from './db'
import { encodeText } from './embed'

export type ModalityFilter = 'all' | 'video' | 'image' | 'text'

export interface SentenceHit {
  start_ms: number
  end_ms: number
  text: string
}

export interface ChunkHit {
  type: 'chunk'
  id: number
  score: number
  source: 'vector' | 'keyword'
  assetId: number
  assetTitle: string
  /** 视频文件路径，前端定位播放用；文本笔记没有对应文件，为 null */
  assetPath: string | null
  /** 该素材最早一帧的缩略图，用作视频卡片封面 */
  coverFrame: string | null
  chunkText: string
  startMs: number
  endMs: number
  /** 句级展开，用于展示与跳转 */
  sentences: SentenceHit[]
}

export interface FrameHit {
  type: 'frame'
  id: number
  score: number
  source: 'frame_vector' | 'caption_vector'
  assetId: number
  assetTitle: string
  timestampMs: number
  thumbPath: string | null
  caption: string | null
}

export interface ImageHit {
  type: 'image'
  id: number
  score: number
  source: 'image_vector' | 'caption_vector' | 'keyword'
  assetId: number
  assetTitle: string
  filePath: string
  caption: string | null
}

export type SearchHit = ChunkHit | FrameHit | ImageHit

const TOP_K_PER_ROUTE = 20

export async function search(
  query: string,
  opts: { modality?: ModalityFilter; topK?: number } = {},
): Promise<SearchHit[]> {
  const modality = opts.modality ?? 'all'
  const topK = opts.topK ?? 30
  const db = getDb()

  const hits: SearchHit[] = []

  // --- 路 3：逐字稿块向量 ---
  if (modality === 'all' || modality === 'video') {
    const [qVec] = await encodeText(query, 'query')
    const rows = db
      .prepare(
        `SELECT c.id, c.text, c.start_ms, c.end_ms, c.embedding,
                a.id AS asset_id, a.title, a.source_path AS asset_path,
                (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                  ORDER BY f.timestamp_ms LIMIT 1) AS cover_frame
         FROM chunks c JOIN transcripts t ON t.id = c.transcript_id
         JOIN assets a ON a.id = t.asset_id
         WHERE c.embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: number
      text: string
      start_ms: number
      end_ms: number
      embedding: Buffer
      asset_id: number
      title: string
      asset_path: string | null
      cover_frame: string | null
    }>

    const scored = rows
      .map((r) => ({ r, score: cosineSim(qVec, blobToEmbedding(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K_PER_ROUTE)

    for (const { r, score } of scored) {
      const sents = db
        .prepare('SELECT start_ms, end_ms, text FROM sentences WHERE chunk_id = ? ORDER BY start_ms')
        .all(r.id) as SentenceHit[]
      hits.push({
        type: 'chunk',
        id: r.id,
        score,
        source: 'vector',
        assetId: r.asset_id,
        assetTitle: r.title,
        assetPath: r.asset_path,
        coverFrame: r.cover_frame,
        chunkText: r.text,
        startMs: r.start_ms,
        endMs: r.end_ms,
        sentences: sents,
      })
    }

    // --- 路 1/2：帧向量与帧描述向量 ---
    const frames = db
      .prepare(
        `SELECT f.id, f.timestamp_ms, f.thumb_path, f.caption, f.embedding, f.caption_embedding,
                a.id AS asset_id, a.title
         FROM frames f JOIN assets a ON a.id = f.asset_id
         WHERE f.embedding IS NOT NULL OR f.caption_embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: number
      timestamp_ms: number
      thumb_path: string | null
      caption: string | null
      embedding: Buffer | null
      caption_embedding: Buffer | null
      asset_id: number
      title: string
    }>

    const frameScored = frames
      .map((f) => ({
        f,
        frameScore: f.embedding ? cosineSim(qVec, blobToEmbedding(f.embedding)) : -1,
        captionScore: f.caption_embedding ? cosineSim(qVec, blobToEmbedding(f.caption_embedding)) : -1,
      }))
      .flatMap((x) => [
        { ...x, score: x.frameScore, source: 'frame_vector' as const },
        { ...x, score: x.captionScore, source: 'caption_vector' as const },
      ])
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K_PER_ROUTE)

    for (const s of frameScored) {
      hits.push({
        type: 'frame',
        id: s.f.id,
        score: s.score,
        source: s.source,
        assetId: s.f.asset_id,
        assetTitle: s.f.title,
        timestampMs: s.f.timestamp_ms,
        thumbPath: s.f.thumb_path,
        caption: s.f.caption,
      })
    }
  }

  // --- 路 4：图片向量 ---
  if (modality === 'all' || modality === 'image') {
    const [qVec] = await encodeText(query, 'query')
    const images = db
      .prepare(
        `SELECT im.id, im.file_path, im.caption, im.embedding, im.caption_embedding,
                a.id AS asset_id, a.title
         FROM images im JOIN assets a ON a.id = im.asset_id
         WHERE im.embedding IS NOT NULL OR im.caption_embedding IS NOT NULL`,
      )
      .all() as Array<{
      id: number
      file_path: string
      caption: string | null
      embedding: Buffer | null
      caption_embedding: Buffer | null
      asset_id: number
      title: string
    }>

    for (const im of images) {
      if (im.embedding) {
        hits.push({
          type: 'image',
          id: im.id,
          score: cosineSim(qVec, blobToEmbedding(im.embedding)),
          source: 'image_vector',
          assetId: im.asset_id,
          assetTitle: im.title,
          filePath: im.file_path,
          caption: im.caption,
        })
      }
      if (im.caption_embedding) {
        hits.push({
          type: 'image',
          id: im.id,
          score: cosineSim(qVec, blobToEmbedding(im.caption_embedding)),
          source: 'caption_vector',
          assetId: im.asset_id,
          assetTitle: im.title,
          filePath: im.file_path,
          caption: im.caption,
        })
      }
    }
  }

  // --- 关键词路（FTS5），与向量路并行存在 ---
  // 已知失效：FTS5 默认 unicode61 tokenizer 不给中文分词，连续中文被当成单个
  // 超长 token，中文查询恒零命中。英文与数字 token 正常（实测 Paraformer、
  // ANN 各命中 1 条）。中文关键词检索需要建索引侧接分词（jieba 一类的
  // 候选），未落地前这条路对中文等于不存在，见 PRD 开放问题 6。
  // 不要把「四路合并」当成四路都有效，现在是三路有效。
  if (modality === 'all' || modality === 'video') {
    let ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' OR ')
    if (ftsQuery) {
      const rows = db
        .prepare(
          `SELECT c.id, c.text, c.start_ms, c.end_ms, a.id AS asset_id, a.title,
                  a.source_path AS asset_path,
                  (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                    ORDER BY f.timestamp_ms LIMIT 1) AS cover_frame,
                  bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN transcripts t ON t.id = c.transcript_id
           JOIN assets a ON a.id = t.asset_id
           WHERE chunks_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, TOP_K_PER_ROUTE) as Array<{
        id: number
        text: string
        start_ms: number
        end_ms: number
        asset_id: number
        title: string
        asset_path: string | null
        cover_frame: string | null
        rank: number
      }>
      for (const r of rows) {
        const sents = db
          .prepare('SELECT start_ms, end_ms, text FROM sentences WHERE chunk_id = ? ORDER BY start_ms')
          .all(r.id) as SentenceHit[]
        hits.push({
          type: 'chunk',
          id: r.id,
          score: -r.rank / 10,
          source: 'keyword',
          assetId: r.asset_id,
          assetTitle: r.title,
          assetPath: r.asset_path,
          coverFrame: r.cover_frame,
          chunkText: r.text,
          startMs: r.start_ms,
          endMs: r.end_ms,
          sentences: sents,
        })
      }
    }
  }

  // 等权合并：同一 id 同 source 只留最高分，然后按分排序
  const best = new Map<string, SearchHit>()
  for (const h of hits) {
    const key = `${h.type}:${h.id}:${h.source}`
    const prev = best.get(key)
    if (!prev || h.score > prev.score) best.set(key, h)
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK)
}

export { embeddingToBlob, VECTOR_DIM }
