/**
 * 检索层。五路加权合并：
 *
 * 1. frames.embedding          帧本身的向量
 * 2. frames.caption_embedding  帧描述文本的向量
 * 3. chunks.embedding          逐字稿块的向量
 * 4. images.embedding          入库图片的向量
 * 5. audio_files.embedding     音频文件本身的向量
 *
 * 首版按等权起步（PRD 开放问题 5）。权重无实测依据，调参需要一批真实
 * 查询做样本，在那之前任何权重都是拍的。
 *
 * 向量查询走暴力余弦（全表扫描 + JS 计算），不用 sqlite-vec 的 ANN。
 * 个人库规模（万级帧）下暴力足够，ANN 的召回损失不值得。
 */

import { getDb, cosineSim, blobToEmbedding, embeddingToBlob, VECTOR_DIM } from './db'
import { embeddingEnabled, encodeText } from './embed'
import { segForQuery, toFtsMatch } from './segment'
import { DEFAULT_COLLECTION_ID, scopeClause, scopeArgs } from './collections'
import { likePattern } from './libraryFilter'
import type { AssetKind } from './db'

export type ModalityFilter = 'all' | 'video' | 'image' | 'audio' | 'text'

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
  /**
   * 媒体文件路径。视频是 mp4、音频是 mp3/wav，前端据此选 <video> 还是
   * <audio>；文本笔记没有对应文件，为 null。
   *
   * **同一条 chunk 路视频与音频共用**，两者的检索语料都是逐字稿 chunk，SQL 与
   * 合并逻辑完全相同，只有渲染与定位播放用的标签不同。早先这里叫 videoPath，
   * 加音频时若另开一路只是把同一段代码抄两份，其中一份将来改了另一份不跟着改。
   */
  assetPath: string | null
  /** 该素材的模态。**chunk 路的两种来源靠它区分**，渲染与定位播放都要用 */
  assetKind: AssetKind
  /** 该素材最早一帧的缩略图，用作视频卡片封面；音频与文本为 null（没有帧） */
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
  source: 'frame_vector' | 'caption_vector' | 'keyword'
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

/**
 * 音频文件本身的命中。**与 chunk 路分开**：chunk 路检索的是转写文本，这一路
 * 检索的是音频内容向量，两者解决不同问题。没有时间戳，因为整条音频一个向量，
 * 定位不到「第几秒说的是什么」；要句级定位仍然走逐字稿 chunk 路。
 */
export interface AudioHit {
  type: 'audio'
  id: number
  score: number
  source: 'audio_vector' | 'keyword'
  assetId: number
  assetTitle: string
  filePath: string
  durationMs: number | null
}

export type SearchHit = ChunkHit | FrameHit | ImageHit | AudioHit

/**
 * 每一路至少给这么多。**搜索分页靠它穿透。**
 *
 * 原来是写死的 20，而四路等权合并后总 topK 默认只有 30，于是「加载更多」翻不出
 * 东西：三类各 20 条候选，合并去重后通常已经不足 30。现在每路的下界跟着调用方的
 * topK 走，翻页请求 topK=48 时每路真的会给出 48 条候选。
 *
 * 仍然留下界：不传 topK 的调用方（脚本、将来的新页面）拿到的是合理的一批，
 * 不是全表。
 */
const MIN_PER_ROUTE = 20

/**
 * 每路的实际上限。取 topK 与下界的较大值。
 *
 * 代价要说清楚：逐字稿那一路每命中一个 chunk 都要另跑一次句子查询（拼句级跳转用），
 * 所以这个数直接是句子查询的次数。放到 48 条时是 48 次查询，比 20 次多但仍是
 * 微秒级；真正的成本在余弦扫描，那个与这个数无关，全表已经算完了。
 */
function perRoute(topK: number): number {
  return Math.max(MIN_PER_ROUTE, topK)
}

export async function search(
  query: string,
  opts: { modality?: ModalityFilter; topK?: number; collectionId?: number } = {},
): Promise<SearchHit[]> {
  if (!embeddingEnabled()) return searchWithoutEmbedding(query, opts)

  const modality = opts.modality ?? 'all'
  const topK = opts.topK ?? 30
  const perRouteK = perRoute(topK)
  // 检索作用域。不给就是默认库，不是全库——全库检索在素材多起来之后只有
  // 变慢一条路，而作用域应该是显式选择而不是默认行为。
  const collectionId = opts.collectionId ?? DEFAULT_COLLECTION_ID
  // 作用域条件统一由 helper 产出，四路不能各拼一次（拼漏就变成「选了全部
  // 却还在按库过滤」，没有报错，只是结果莫名变少）
  const scope = scopeClause(collectionId)
  const scopeArg = scopeArgs(collectionId)
  const db = getDb()

  const hits: SearchHit[] = []
  const chunkKinds = modality === 'all' ? ['video', 'audio', 'text'] : modality === 'image' ? [] : [modality]
  const chunkKindPlaceholders = chunkKinds.map(() => '?').join(',')
  let queryVector: Float32Array | undefined
  const getQueryVector = async () => {
    if (!queryVector) [queryVector] = await encodeText(query, 'query')
    return queryVector
  }

  // --- 路 3：逐字稿块向量（视频、音频与文本共用）---
  // 三类素材的检索语料同构，模态过滤落在 assets.kind 上。音频与文本没有 frames，
  // 不能因为共用 chunks 就把视频的帧结果带进来。
  if (chunkKinds.length > 0) {
    const qVec = await getQueryVector()
    const rows = db
      .prepare(
        `SELECT c.id, c.text, c.start_ms, c.end_ms, c.embedding,
                a.id AS asset_id, a.title, a.source_path AS asset_path,
                a.kind AS asset_kind,
                (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                  ORDER BY f.timestamp_ms LIMIT 1) AS cover_frame
         FROM chunks c JOIN transcripts t ON t.id = c.transcript_id
         JOIN assets a ON a.id = t.asset_id
         WHERE c.embedding IS NOT NULL ${scope} AND a.kind IN (${chunkKindPlaceholders})`,
      )
      .all(...scopeArg, ...chunkKinds) as Array<{
      id: number
      text: string
      start_ms: number
      end_ms: number
      embedding: Buffer
      asset_id: number
      title: string
      asset_path: string | null
      asset_kind: string
      cover_frame: string | null
    }>

    const scored = rows
      .map((r) => ({ r, score: cosineSim(qVec, blobToEmbedding(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, perRouteK)

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
        assetKind: r.asset_kind as AssetKind,
        coverFrame: r.cover_frame,
        chunkText: r.text,
        startMs: r.start_ms,
        endMs: r.end_ms,
        sentences: sents,
      })
    }

  }

  // --- 路 1/2：帧向量与帧描述向量，只属于视频 ---
  if (modality === 'all' || modality === 'video') {
    const qVec = await getQueryVector()
    const frames = db
      .prepare(
        `SELECT f.id, f.timestamp_ms, f.thumb_path, f.caption, f.embedding, f.caption_embedding,
                a.id AS asset_id, a.title
         FROM frames f JOIN assets a ON a.id = f.asset_id
         WHERE (f.embedding IS NOT NULL OR f.caption_embedding IS NOT NULL)
           AND a.kind = 'video' ${scope}`,
      )
      .all(...scopeArg) as Array<{
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
      .slice(0, perRouteK)

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
    const qVec = await getQueryVector()
    const images = db
      .prepare(
        `SELECT im.id, im.file_path, im.caption, im.embedding, im.caption_embedding,
                a.id AS asset_id, a.title
         FROM images im JOIN assets a ON a.id = im.asset_id
         WHERE (im.embedding IS NOT NULL OR im.caption_embedding IS NOT NULL)
           ${scope}`,
      )
      .all(...scopeArg) as Array<{
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

  // --- 路 5：音频文件本身的向量 ---
  // 与逐字稿路分开：这一路让文字查询直接匹配音频内容，不要求 ASR 先转写出
  // 同样的词。音频模态因此会同时出现 chunk（转写）与 audio（声学/内容）两类
  // 命中，去重键里的 type 不同，不会互相覆盖。
  if (modality === 'all' || modality === 'audio') {
    const qVec = await getQueryVector()
    const audios = db
      .prepare(
        `SELECT af.id, af.file_path, af.duration_ms, af.embedding,
                a.id AS asset_id, a.title
         FROM audio_files af JOIN assets a ON a.id = af.asset_id
         WHERE af.embedding IS NOT NULL ${scope}`,
      )
      .all(...scopeArg) as Array<{
      id: number
      file_path: string
      duration_ms: number | null
      embedding: Buffer
      asset_id: number
      title: string
    }>

    const audioScored = audios
      .map((au) => ({ au, score: cosineSim(qVec, blobToEmbedding(au.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, perRouteK)

    for (const { au, score } of audioScored) {
      hits.push({
        type: 'audio',
        id: au.id,
        score,
        source: 'audio_vector',
        assetId: au.asset_id,
        assetTitle: au.title,
        filePath: au.file_path,
        durationMs: au.duration_ms,
      })
    }
  }

  // --- 关键词路（FTS5），与向量路并行存在 ---
  // 中文经索引侧分词（src/lib/segment.ts，触发器在写入时切分）后可用：查询侧
  // 过同一把刀，连续中文整句查询也能命中。英文与数字 token 行为不变。
  // 停用词查询（tokens 为空）不查：空串 MATCH 会抛错，而「只打了语气词」
  // 不是错误，是不该查。
  if (chunkKinds.length > 0) {
    const tokens = segForQuery(query)
    const ftsQuery = tokens.length ? toFtsMatch(tokens) : ''
    if (ftsQuery) {
      const rows = db
        .prepare(
          `SELECT c.id, c.text, c.start_ms, c.end_ms, a.id AS asset_id, a.title,
                  a.source_path AS asset_path,
                  (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                    ORDER BY f.timestamp_ms LIMIT 1) AS cover_frame,
                  a.kind AS asset_kind,
                  bm25(chunks_fts) AS rank
           FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
           JOIN transcripts t ON t.id = c.transcript_id
           JOIN assets a ON a.id = t.asset_id
           WHERE chunks_fts MATCH ? ${scope} AND a.kind IN (${chunkKindPlaceholders})
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, ...scopeArg, ...chunkKinds, perRouteK) as Array<{
        id: number
        text: string
        start_ms: number
        end_ms: number
        asset_id: number
        title: string
        asset_path: string | null
        asset_kind: string
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
          assetKind: r.asset_kind as AssetKind,
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

/**
 * 轻量版检索：不请求向量服务。逐字稿走 FTS5，图片与关键帧走标题、标签、
 * 描述的 LIKE 关键词匹配。ASR 与视觉描述仍照常入库，所以两条核心生产链
 * 在轻量版里继续为检索提供文本。
 */
async function searchWithoutEmbedding(
  query: string,
  opts: { modality?: ModalityFilter; topK?: number; collectionId?: number },
): Promise<SearchHit[]> {
  const modality = opts.modality ?? 'all'
  const topK = opts.topK ?? 30
  const perRouteK = perRoute(topK)
  const collectionId = opts.collectionId ?? DEFAULT_COLLECTION_ID
  const scope = scopeClause(collectionId)
  const scopeArg = scopeArgs(collectionId)
  const db = getDb()
  const hits: SearchHit[] = []

  const tokens = segForQuery(query)
  const ftsQuery = tokens.length ? toFtsMatch(tokens) : ''
  const chunkKinds = modality === 'all' ? ['video', 'audio', 'text'] : modality === 'image' ? [] : [modality]
  if (ftsQuery && chunkKinds.length > 0) {
    const placeholders = chunkKinds.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT c.id, c.text, c.start_ms, c.end_ms, a.id AS asset_id, a.title,
                a.source_path AS asset_path, a.kind AS asset_kind,
                (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                  ORDER BY f.timestamp_ms LIMIT 1) AS cover_frame,
                bm25(chunks_fts) AS rank
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN transcripts t ON t.id = c.transcript_id
         JOIN assets a ON a.id = t.asset_id
         WHERE chunks_fts MATCH ? ${scope} AND a.kind IN (${placeholders})
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, ...scopeArg, ...chunkKinds, perRouteK) as Array<{
      id: number
      text: string
      start_ms: number
      end_ms: number
      asset_id: number
      title: string
      asset_path: string | null
      asset_kind: AssetKind
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
        assetKind: r.asset_kind,
        coverFrame: r.cover_frame,
        chunkText: r.text,
        startMs: r.start_ms,
        endMs: r.end_ms,
        sentences: sents,
      })
    }
  }

  const pattern = likePattern(query)
  if (pattern && (modality === 'all' || modality === 'video')) {
    const frames = db
      .prepare(
        `SELECT f.id, f.timestamp_ms, f.thumb_path, f.caption,
                a.id AS asset_id, a.title
         FROM frames f JOIN assets a ON a.id = f.asset_id
         WHERE (a.title LIKE ? ESCAPE '\\' OR COALESCE(f.caption, '') LIKE ? ESCAPE '\\'
                OR a.tags_json LIKE ? ESCAPE '\\') AND a.kind = 'video' ${scope}
         ORDER BY f.id DESC LIMIT ?`,
      )
      .all(pattern, pattern, pattern, ...scopeArg, perRouteK) as Array<{
      id: number
      timestamp_ms: number
      thumb_path: string | null
      caption: string | null
      asset_id: number
      title: string
    }>
    for (const f of frames) {
      hits.push({
        type: 'frame',
        id: f.id,
        score: 0.5,
        source: 'keyword',
        assetId: f.asset_id,
        assetTitle: f.title,
        timestampMs: f.timestamp_ms,
        thumbPath: f.thumb_path,
        caption: f.caption,
      })
    }
  }

  if (pattern && (modality === 'all' || modality === 'image')) {
    const images = db
      .prepare(
        `SELECT im.id, im.file_path, im.caption, a.id AS asset_id, a.title
         FROM images im JOIN assets a ON a.id = im.asset_id
         WHERE (a.title LIKE ? ESCAPE '\\' OR COALESCE(im.caption, '') LIKE ? ESCAPE '\\'
                OR a.tags_json LIKE ? ESCAPE '\\') ${scope}
         ORDER BY im.id DESC LIMIT ?`,
      )
      .all(pattern, pattern, pattern, ...scopeArg, perRouteK) as Array<{
      id: number
      file_path: string
      caption: string | null
      asset_id: number
      title: string
    }>
    for (const im of images) {
      hits.push({
        type: 'image',
        id: im.id,
        score: 0.5,
        source: 'keyword',
        assetId: im.asset_id,
        assetTitle: im.title,
        filePath: im.file_path,
        caption: im.caption,
      })
    }
  }

  const best = new Map<string, SearchHit>()
  for (const h of hits) {
    const key = `${h.type}:${h.id}:${h.source}`
    const prev = best.get(key)
    if (!prev || h.score > prev.score) best.set(key, h)
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK)
}

export { embeddingToBlob, VECTOR_DIM }
