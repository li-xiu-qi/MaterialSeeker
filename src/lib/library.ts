import { getDb } from './db'
import { toMediaUrl } from './media'
import { scopeClause, scopeArgs, ALL_COLLECTIONS } from './collections'

/**
 * 素材详情取数。详情页（服务端组件）与详情接口（API）共用这一份实现，
 * 避免同一批 SQL 在两地各存一份后悄悄走岔。
 *
 * 相似邻居是全表余弦：库里几百张图的量级下这样最省事，真到上万再谈 ANN。
 */

const DIM = 1024
const NEIGHBOURS = 8

export interface ImageDetail {
  asset: {
    id: number
    title: string
    createdAt: string
    filePath: string
    caption: string | null
    hasVector: boolean
    hasCaptionVector: boolean
  }
  /** 原图地址，给放大预览用 */
  url: string | null
  neighbours: Array<{
    id: number
    title: string
    url: string | null
    caption: string | null
    score: number
  }>
}

export interface VideoDetail {
  asset: {
    id: number
    title: string
    sourcePath: string | null
    createdAt: string
    meta: Record<string, unknown>
  }
  videoUrl: string | null
  transcript: {
    fullText: string
    language: string | null
    asrEngine: string | null
    sentences: Array<{ startMs: number; endMs: number; text: string }>
    chunks: Array<{
      id: number
      startMs: number
      endMs: number
      strategy: string
      sentenceCount: number
    }>
  } | null
  frames: Array<{
    id: number
    timestampMs: number
    url: string | null
    caption: string | null
    sceneIndex: number | null
  }>
}

export interface LibraryCounts {
  video: number
  image: number
  text: number
}

export interface LibraryList {
  counts: LibraryCounts
  /** true 表示这次没按库过滤，此时各行必须显示 collectionName */
  allCollections: boolean
  video: Array<{
    id: number
    title: string
    sourcePath: string | null
    createdAt: string
    cover: string | null
    frames: number
    chunks: number
    sentences: number
    collectionId: number
    collectionName: string
  }>
  image: Array<{
    id: number
    title: string
    sourcePath: string | null
    mediaPath: string | null
    createdAt: string
    caption: string | null
    hasVector: boolean
    hasCaptionVector: boolean
    collectionId: number
    collectionName: string
  }>
  text: Array<{
    id: number
    title: string
    createdAt: string
    chars: number
    hasVector: boolean
    collectionId: number
    collectionName: string
  }>
}

export function getLibraryList(collectionId: number = ALL_COLLECTIONS): LibraryList {
  const db = getDb()
  // 不给 collectionId 就是全库（管理面用）；给了就只读那一个库，这是检索
  // 作用域的同一条规则，素材库页面与检索共用。
  // 三条 SQL 本身都已有 WHERE a.kind = ...，所以只能是 AND，再拼一个 WHERE
  // 会直接语法错误（实测报 near "WHERE": syntax error）。全部库时片段为空串。
  const scope = scopeClause(collectionId)
  const scopeArg = scopeArgs(collectionId)

  // 计数由取回的列表长度算出（见函数尾部的 return），不单独跑 GROUP BY：
  // 单独跑会用全库统计，按库过滤时列表是空的而计数还显示 140，两边对不上。

  const video = db
    .prepare(
      `SELECT a.id, a.title, a.source_path, a.created_at,
              (SELECT count(*) FROM frames f WHERE f.asset_id = a.id) AS frames,
              (SELECT count(*) FROM chunks c JOIN transcripts t ON t.id = c.transcript_id
                WHERE t.asset_id = a.id) AS chunks,
              (SELECT count(*) FROM transcript_sentences s JOIN transcripts t ON t.id = s.transcript_id
                WHERE t.asset_id = a.id) AS sentences,
              (SELECT f2.thumb_path FROM frames f2 WHERE f2.asset_id = a.id
                ORDER BY f2.timestamp_ms LIMIT 1) AS cover
       FROM assets a JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'video' ${scope} ORDER BY a.id DESC`,
    )
    .all(...scopeArg) as Array<{
    id: number
    title: string
    source_path: string | null
    created_at: string
    frames: number
    chunks: number
    sentences: number
    cover: string | null
    collection_id: number
    collection_name: string
  }>

  const image = db
    .prepare(
      `SELECT a.id, a.title, a.source_path, a.created_at, a.collection_id,
              c.name AS collection_name, im.caption,
              COALESCE(im.file_path, a.source_path) AS media_path,
              (im.embedding IS NOT NULL) AS has_vec,
              (im.caption_embedding IS NOT NULL) AS has_caption_vec
       FROM assets a JOIN images im ON im.asset_id = a.id
       JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'image' ${scope} ORDER BY a.id DESC`,
    )
    .all(...scopeArg) as Array<{
    id: number
    title: string
    source_path: string | null
    created_at: string
    caption: string | null
    media_path: string | null
    has_vec: number
    has_caption_vec: number
    collection_id: number
    collection_name: string
  }>

  const text = db
    .prepare(
      `SELECT a.id, a.title, a.created_at, a.collection_id,
              c.name AS collection_name, length(n.content) AS chars,
              (n.embedding IS NOT NULL) AS has_vec
       FROM assets a JOIN text_notes n ON n.asset_id = a.id
       JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'text' ${scope} ORDER BY a.id DESC`,
    )
    .all(...scopeArg) as Array<{
    id: number
    title: string
    created_at: string
    chars: number
    has_vec: number
    collection_id: number
    collection_name: string
  }>

  return {
    allCollections: collectionId === ALL_COLLECTIONS,
    counts: {
      video: video.length,
      image: image.length,
      text: text.length,
    },
    video: video.map((v) => ({
      id: v.id,
      collectionId: v.collection_id,
      collectionName: v.collection_name,
      title: v.title,
      sourcePath: v.source_path,
      createdAt: v.created_at,
      cover: v.cover,
      frames: v.frames,
      chunks: v.chunks,
      sentences: v.sentences,
    })),
    image: image.map((im) => ({
      id: im.id,
      collectionId: im.collection_id,
      collectionName: im.collection_name,
      title: im.title,
      sourcePath: im.source_path,
      mediaPath: im.media_path,
      createdAt: im.created_at,
      caption: im.caption,
      hasVector: Boolean(im.has_vec),
      hasCaptionVector: Boolean(im.has_caption_vec),
    })),
    text: text.map((t) => ({
      id: t.id,
      collectionId: t.collection_id,
      collectionName: t.collection_name,
      title: t.title,
      createdAt: t.created_at,
      chars: t.chars,
      hasVector: Boolean(t.has_vec),
    })),
  }
}

export function getImageDetail(id: number): ImageDetail | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT a.id, a.title, a.created_at, im.file_path, im.caption,
              im.embedding, im.caption_embedding
       FROM assets a JOIN images im ON im.asset_id = a.id WHERE a.id = ?`,
    )
    .get(id) as
    | {
        id: number
        title: string
        created_at: string
        file_path: string
        caption: string | null
        embedding: Buffer | null
        caption_embedding: Buffer | null
      }
    | undefined

  if (!row) return null

  const vec = row.embedding ? blobToVec(row.embedding) : null

  let neighbours: ImageDetail['neighbours'] = []
  if (vec) {
    const others = db
      .prepare(
        `SELECT a.id, a.title, im.file_path, im.caption, im.embedding
         FROM assets a JOIN images im ON im.asset_id = a.id
         WHERE a.id != ? AND im.embedding IS NOT NULL`,
      )
      .all(row.id) as Array<{
      id: number
      title: string
      file_path: string
      caption: string | null
      embedding: Buffer
    }>

    neighbours = others
      .map((o) => ({ o, score: cosine(vec, blobToVec(o.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, NEIGHBOURS)
      .map(({ o, score }) => ({
        id: o.id,
        title: o.title,
        url: toThumb(o.file_path),
        caption: o.caption,
        score,
      }))
  }

  return {
    asset: {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      filePath: row.file_path,
      caption: row.caption,
      hasVector: Boolean(row.embedding),
      hasCaptionVector: Boolean(row.caption_embedding),
    },
    url: toMediaUrl(row.file_path),
    neighbours,
  }
}

export function getVideoDetail(id: number): VideoDetail | null {
  const db = getDb()
  const asset = db
    .prepare('SELECT id, kind, title, source_path, created_at, meta_json FROM assets WHERE id = ?')
    .get(id) as
    | {
        id: number
        kind: string
        title: string
        source_path: string | null
        created_at: string
        meta_json: string | null
      }
    | undefined

  if (!asset || asset.kind !== 'video') return null

  const transcript = db
    .prepare('SELECT full_text, language, asr_engine FROM transcripts WHERE asset_id = ?')
    .get(id) as
    | { full_text: string; language: string | null; asr_engine: string | null }
    | undefined

  let sentences: Array<{ start_ms: number; end_ms: number; text: string }> = []
  let chunks: Array<{
    id: number
    start_ms: number
    end_ms: number
    chunk_strategy: string
    sent_count: number
  }> = []
  if (transcript) {
    const t = db
      .prepare('SELECT id FROM transcripts WHERE asset_id = ?')
      .get(id) as { id: number }
    sentences = db
      .prepare(
        'SELECT start_ms, end_ms, text FROM transcript_sentences WHERE transcript_id = ? ORDER BY start_ms',
      )
      .all(t.id) as Array<{ start_ms: number; end_ms: number; text: string }>
    chunks = db
      .prepare(
        `SELECT c.id, c.start_ms, c.end_ms, c.chunk_strategy,
                (SELECT count(*) FROM sentences s WHERE s.chunk_id = c.id) AS sent_count
         FROM chunks c WHERE c.transcript_id = ? ORDER BY c.start_ms`,
      )
      .all(t.id) as Array<{
      id: number
      start_ms: number
      end_ms: number
      chunk_strategy: string
      sent_count: number
    }>
  }

  const frames = db
    .prepare(
      'SELECT id, timestamp_ms, thumb_path, caption, scene_index FROM frames WHERE asset_id = ? ORDER BY timestamp_ms',
    )
    .all(id) as Array<{
    id: number
    timestamp_ms: number
    thumb_path: string | null
    caption: string | null
    scene_index: number | null
  }>

  return {
    asset: {
      id: asset.id,
      title: asset.title,
      sourcePath: asset.source_path,
      createdAt: asset.created_at,
      meta: asset.meta_json ? (JSON.parse(asset.meta_json) as Record<string, unknown>) : {},
    },
    videoUrl: toMediaUrl(asset.source_path),
    transcript: transcript
      ? {
          fullText: transcript.full_text,
          language: transcript.language,
          asrEngine: transcript.asr_engine,
          sentences: sentences.map((s) => ({
            startMs: s.start_ms,
            endMs: s.end_ms,
            text: s.text,
          })),
          chunks: chunks.map((c) => ({
            id: c.id,
            startMs: c.start_ms,
            endMs: c.end_ms,
            strategy: c.chunk_strategy,
            sentenceCount: c.sent_count,
          })),
        }
      : null,
    frames: frames.map((f) => ({
      id: f.id,
      timestampMs: f.timestamp_ms,
      url: toMediaUrl(f.thumb_path),
      caption: f.caption,
      sceneIndex: f.scene_index,
    })),
  }
}

function toThumb(abs: string | null): string | null {
  const url = toMediaUrl(abs)
  return url ? `${url}?w=192` : null
}

function blobToVec(b: Buffer): Float32Array {
  const out = new Float32Array(b.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4)
  return out
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RecentAsset {
  id: number
  kind: 'video' | 'image' | 'text'
  title: string
  caption: string | null
  createdAt: string
  /** 列表用小图，视频取首帧、图片取自身 */
  thumbUrl: string | null
  /** 详情页地址，三种模态各自一条 */
  detailHref: string
}

/**
 * 最近入库的素材，按作用域取。给检索页的空状态用：没有查询时页面中央是检索栏，
 * 下面铺一排最近入库，让落地页不是空的，也让人知道库里有什么、从哪下手。
 *
 * kind 必须在 SQL 里过滤，不能取回来再筛。取回来再筛的后果是「最近 24 条全是
 * 图片，按文本筛就一条不剩」——库里明明有 3 条文本，落地页却空着一块，看着像
 * bug。在 SQL 里按类型取，拿到的才是「最近的文本」而不是「最近的里面挑文本」。
 */
export function getRecentAssets(
  collectionId: number,
  limit = 12,
  kind?: 'video' | 'image' | 'text',
): RecentAsset[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.title, a.created_at, im.caption, im.file_path,
              (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                ORDER BY f.timestamp_ms LIMIT 1) AS cover
       FROM assets a LEFT JOIN images im ON im.asset_id = a.id
       WHERE 1 = 1 ${scopeClause(collectionId)} ${kind ? 'AND a.kind = ?' : ''}
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...scopeArgs(collectionId), ...(kind ? [kind] : []), limit) as Array<{
    id: number
    kind: string
    title: string
    created_at: string
    caption: string | null
    file_path: string | null
    cover: string | null
  }>

  return rows.map((r) => {
    const thumb = r.kind === 'video' ? r.cover : r.file_path
    return {
      id: r.id,
      kind: r.kind as RecentAsset['kind'],
      title: r.title,
      caption: r.caption,
      createdAt: r.created_at,
      thumbUrl: toMediaUrl(thumb),
      detailHref:
        r.kind === 'video'
          ? `/library/video/${r.id}`
          : r.kind === 'image'
            ? `/library/image/${r.id}`
            : `/library?lib=${collectionId === ALL_COLLECTIONS ? 'all' : collectionId}`,
    }
  })
}

export interface LibraryFilter {
  kind?: 'video' | 'image' | 'text'
  /** 标题与说明的子串匹配，中文按子串走 LIKE，不依赖分词 */
  q?: string
}

/**
 * 带筛选的素材列表。给素材库页与检索页的筛选用。
 *
 * 关键词用 LIKE 子串而不是 FTS：FTS 默认 tokenizer 不分词中文，中文查询恒零命中
 * （这个坑记在 search.ts 与 PRD 开放问题 6）。素材库这边只是按标题和说明过一遍
 * 已经取回来的几百条，LIKE 足够，也不值得为它引入分词。
 */
export function filterLibraryList(list: LibraryList, filter: LibraryFilter): LibraryList {
  const kw = filter.q?.trim().toLowerCase() ?? ''
  const keep = (title: string, caption: string | null) => {
    if (!kw) return true
    return (
      title.toLowerCase().includes(kw) || (caption ?? '').toLowerCase().includes(kw)
    )
  }
  return {
    counts: list.counts,
    // 必须透传：丢了它，素材库页就不知道该给每行标注所属库
    allCollections: list.allCollections,
    video: filter.kind && filter.kind !== 'video' ? [] : list.video.filter((v) => keep(v.title, null)),
    image:
      filter.kind && filter.kind !== 'image'
        ? []
        : list.image.filter((im) => keep(im.title, im.caption)),
    text: filter.kind && filter.kind !== 'text' ? [] : list.text.filter((t) => keep(t.title, null)),
  }
}
