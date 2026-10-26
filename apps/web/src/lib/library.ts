import { getDb } from './db'
import { toMediaUrl } from './media'
import { scopeClause, scopeArgs, ALL_COLLECTIONS } from './collections'
import { loadTags } from './tags'
import {
  libraryWhere,
  MAX_PAGE,
  type LibraryList,
  type LibraryQuery,
  type LibraryCounts,
} from './libraryFilter'

/**
 * 列表类型与筛选条件住在 libraryFilter.ts。**不要在这里再抄一份。**
 *
 * 那边的顶层 import 只有类型与纯函数，不碰 better-sqlite3；这个文件的 db 依赖
 * 进不了测试环境，所以纯逻辑必须留在那边才能被断言。这里 re-export 是为了让
 * 页面与接口的 import 路径不变，不是为了再用一处。
 *
 * 上面那句 `import ... type` 与下面的 `export type` 不重复：前者供本文件内的
 * 函数签名用，后者供外部按老路径 import。只写后者的话，本文件自己用不到这些名字。
 */
export type { LibraryCounts, LibraryList, LibraryFilter, LibraryQuery } from './libraryFilter'
export { libraryWhere, MAX_PAGE } from './libraryFilter'

/**
 * 素材详情取数。详情页（服务端组件）与详情接口（API）共用这一份实现，
 * 避免同一批 SQL 在两地各存一份后悄悄走岔。
 *
 * 相似邻居是全表余弦：库里几百张图的量级下这样最省事，真到上万再谈 ANN。
 */

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

export interface TextDetail {
  asset: {
    id: number
    title: string
    createdAt: string
    content: string
    chars: number
    hasVector: boolean
  }
}

/**
 * 音频详情。**没有 frames 那一层**：音频没有帧，也不需要（画面信息为零）。
 * 其余结构与 VideoDetail 一致，逐字稿、句流、检索块全部复用视频那套表。
 */
export interface AudioDetail {
  asset: {
    id: number
    title: string
    sourcePath: string | null
    createdAt: string
    meta: Record<string, unknown>
  }
  audioUrl: string | null
  durationMs: number | null
  /** 标签。从 assets.tags_json 读，不放在 meta_json 里（那栏存的是入库统计） */
  tags: string[]
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
}

export interface VideoDetail {
  asset: {
    id: number
    title: string
    sourcePath: string | null
    createdAt: string
    /** 视频流时长；旧数据可能尚未回填，为 null 时界面显示未知。 */
    durationMs: number | null
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

/**
 * 库内存量三个数。**只跑 COUNT，一行都不取。**
 *
 * 落地页与 counts 接口只要这三个数。走 getLibraryList 等于把全库素材读出来再数
 * 自己读了多少条；几百条素材时那是一次白取的往返，而调用方要的只是三个整数。
 */
export function getLibraryCounts(collectionId: number = ALL_COLLECTIONS): LibraryCounts {
  const db = getDb()
  const scope = scopeClause(collectionId)
  const scopeArg = scopeArgs(collectionId)
  return {
    video: countKind(db, 'video', scope, scopeArg),
    image: countKind(db, 'image', scope, scopeArg),
    audio: countKind(db, 'audio', scope, scopeArg),
    text: countKind(db, 'text', scope, scopeArg),
  }
}

function countKind(
  db: ReturnType<typeof getDb>,
  kind: 'video' | 'image' | 'audio' | 'text',
  scope: string,
  scopeArg: unknown[],
): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM assets a WHERE a.kind = ? ${scope}`)
    .get(kind, ...scopeArg) as { n: number }
  return row.n
}

/** 一类的取数结果。total 是筛选后的命中总数，与 limit 无关 */
interface Page<T> {
  rows: T[]
  total: number
}

/**
 * 跑「计数 + 一页」两条同 WHERE 的查询。**两条查询共用同一个筛选片段。**
 *
 * 分成两条而不是用窗口函数一次拿到，是因为三条查询都要它，而窗口函数的写法在
 * better-sqlite3 里要把 count 包在子查询外层才不破坏 LIMIT 语义，比两条简单查询
 * 更难读。两次扫描的代价与原来一次全量取回加全量 JS filter 相比小一个数量级。
 *
 * **countSql 必须由调用方给，不从 selectSql 截。** 截取这个念头本身是错的：三条
 * select 的开头都是 SELECT ...（视频那条的子查询里还有三个 FROM），正则找「第一个
 * FROM」会在子查询上截断，拼出的 SQL 是 `SELECT count(*) FROM frames f WHERE ...`
 * 再接后半截，直接语法错。显式给一条同 FROM 同 WHERE 的 count，改一处 select
 * 就改一处 count，看得见对得上。
 */
function page<T>(
  db: ReturnType<typeof getDb>,
  scope: string,
  scopeArg: unknown[],
  whereSql: string,
  whereArgs: unknown[],
  limit: number | null,
  selectSql: string,
  /** 与 selectSql 同 FROM 同 WHERE、只查 count(*) 的那一条 */
  countSql: string,
): Page<T> {
  const total = (
    db.prepare(countSql).get(...scopeArg, ...whereArgs) as { n: number }
  ).n

  // limit 为 null 时不拼 LIMIT 而不是绑 null：绑 null 在 better-sqlite3 里会按
  // 类型错报，而语义本该是「不限」，拼两套 SQL 更直白。
  const sql = limit === null ? selectSql : `${selectSql} LIMIT ${limit}`
  const rows = db.prepare(sql).all(...scopeArg, ...whereArgs) as T[]
  return { rows, total }
}

/**
 * 素材库一页。**筛选与分页都压在 SQL 里，不取回来再筛。**
 *
 * 这一条是这次优化的全部要点，按代价从大到小：
 *
 * 1. 原来三个查询一条 LIMIT 都没有，`slice(0, shown)` 切的是已经取完的结果集。
 *    取 145 条与取 24 条的差别不只是 SQL 时间，还有每行三四个子查询（帧数、块数、
 *    句数、封面）和一次全量 JS map。「大规模内容时有点卡」卡的是这里，不是渲染。
 *    现在 LIMIT 直接把每类条数钉在 SQL 上。
 *
 * 2. 原来 kind 与关键词都在 JS 里 filter，而 limit 只作用于图片一类，于是视频与
 *    文本实际是全量渲染的：一个库有 300 个视频就渲染 300 张卡片。现在三个数都
 *    来自 SQL，页面不再自己切。
 *
 * 3. 空态文案需要准确的 total。counts 是库内存量，total 是筛选后的命中数，页面
 *    靠后者区分「被类型筛掉了」与「没有匹配」。这要求筛选用 SQL：在内存里筛的话
 *    total 只能数自己取回的那几条，永远 ≤ limit。
 *
 * **不给 collectionId 就是全库**（管理面用）；给了就只读那一个库，这是检索作用域
 * 的同一条规则，素材库页面与检索共用。三条 SQL 本身都已有 WHERE a.kind = ...，
 * 所以只能是 AND，再拼一个 WHERE 会直接语法错误。全部库时作用域片段为空串。
 */
export function getLibraryList(
  collectionId: number = ALL_COLLECTIONS,
  query: LibraryQuery = {},
): LibraryList {
  const db = getDb()
  const scope = scopeClause(collectionId)
  const scopeArg = scopeArgs(collectionId)
  const counts = getLibraryCounts(collectionId)

  // 筛选片段由纯函数产出，三条查询共用一份规则。**不在这里各拼一次**：拼漏一处
  // 的后果是那一类不按关键词筛，而页面上三类并排显示，错得显眼但很难定位。
  const where = libraryWhere(query)
  // limit 不给就是全量（接口与 counts 都要）。0 与不给等价，不是「取 0 条」。
  const limit =
    query.limit && query.limit > 0 ? Math.min(Math.trunc(query.limit), MAX_PAGE) : null

  /**
   * 类型筛选。**没被选中的那一类整条查询都不跑，返回空结果。**

   *
   * 这个字段曾在整个文件里一次都没被读到，后果是选了「文本」视频与图片照样显示
   * （用户报过）。原因是把筛选从内存搬到 SQL 那次：旧实现在 JS 里 filter，类型
   * 被筛掉的两组返回空数组；新实现的注释写了「类型不进 WHERE 片段，由各查询自己
   * 写 a.kind = ?」，而三条 SQL 里的 a.kind 全是写死的字面量，没有任何一层读
   * query.kind。类型筛选就此凭空消失，且不报错——只是三类全出来。

   *

   * 不跑查询而不是 `AND 1=0`：后者仍要付一次全表扫描加 count，而这一组注定是空的。

   * 直接给空结果，顺带让 total 为 0，页面的「已被类型筛选排除」空态文案才对得上。

   *

   * counts 不受影响：那是库内存量，始终全量算，页面顶部那行说的是库里有什么。

   */
  const wanted = (k: 'video' | 'image' | 'audio' | 'text') => !query.kind || query.kind === k
  const EMPTY_PAGE = { rows: [], total: 0 }

  const video = wanted('video')
    ? page<{
    id: number
    title: string
    source_path: string | null
    created_at: string
    frames: number
    chunks: number
    sentences: number
    cover: string | null
    tags_json: string | null
    collection_id: number
    collection_name: string
  }>(
    db,
    scope,
    scopeArg,
    where.sql,
    where.args,
    limit,
    `SELECT a.id, a.title, a.source_path, a.created_at,
            (SELECT count(*) FROM frames f WHERE f.asset_id = a.id) AS frames,
            (SELECT count(*) FROM chunks c JOIN transcripts t ON t.id = c.transcript_id
              WHERE t.asset_id = a.id) AS chunks,
            (SELECT count(*) FROM transcript_sentences s JOIN transcripts t ON t.id = s.transcript_id
              WHERE t.asset_id = a.id) AS sentences,
            (SELECT f2.thumb_path FROM frames f2 WHERE f2.asset_id = a.id
              ORDER BY f2.timestamp_ms LIMIT 1) AS cover,
            a.tags_json,
            a.collection_id, c.name AS collection_name
     FROM assets a JOIN collections c ON c.id = a.collection_id
     WHERE a.kind = 'video' ${scope} ${where.sql} ORDER BY a.id DESC`,
      `SELECT count(*) AS n
       FROM assets a JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'video' ${scope} ${where.sql}`,
    )
    : EMPTY_PAGE

  const image = wanted('image')
    ? page<{
    id: number
    title: string
    source_path: string | null
    created_at: string
    caption: string | null
    media_path: string | null
    has_vec: number
    has_caption_vec: number
    tags_json: string | null
    collection_id: number
    collection_name: string
  }>(
    db,
    scope,
    scopeArg,
    where.sql,
    where.args,
    limit,
    `SELECT a.id, a.title, a.source_path, a.created_at, a.collection_id,
            c.name AS collection_name, im.caption, a.tags_json,
            COALESCE(im.file_path, a.source_path) AS media_path,
            (im.embedding IS NOT NULL) AS has_vec,
            (im.caption_embedding IS NOT NULL) AS has_caption_vec
     FROM assets a JOIN images im ON im.asset_id = a.id
     JOIN collections c ON c.id = a.collection_id
     WHERE a.kind = 'image' ${scope} ${where.sql} ORDER BY a.id DESC`,
      `SELECT count(*) AS n
       FROM assets a JOIN images im ON im.asset_id = a.id
       JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'image' ${scope} ${where.sql}`,
    )
    : EMPTY_PAGE

  const text = wanted('text')
    ? page<{
    id: number
    title: string
    source_path: string | null
    created_at: string
    content: string
    chars: number
    has_vec: number
    tags_json: string | null
    collection_id: number
    collection_name: string
  }>(
    db,
    scope,
    scopeArg,
    where.sql,
    where.args,
    limit,
    `SELECT a.id, a.title, a.source_path, a.created_at, a.collection_id,
            c.name AS collection_name, n.content, length(n.content) AS chars,
            a.tags_json,
            (n.embedding IS NOT NULL) AS has_vec
     FROM assets a JOIN text_notes n ON n.asset_id = a.id
     JOIN collections c ON c.id = a.collection_id
     WHERE a.kind = 'text' ${scope} ${where.sql} ORDER BY a.id DESC`,
      `SELECT count(*) AS n
       FROM assets a JOIN text_notes n ON n.asset_id = a.id
       JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'text' ${scope} ${where.sql}`,
    )
    : EMPTY_PAGE

  // --- 音频段。字段比视频少两个：没有帧数与关键帧封面 ---
  const audio = wanted('audio')
    ? page<{
    id: number
    title: string
    source_path: string | null
    created_at: string
    duration_ms: number | null
    file_path: string | null
    chunks: number
    sentences: number
    tags_json: string | null
    collection_id: number
    collection_name: string
  }>(
    db,
    scope,
    scopeArg,
    where.sql,
    where.args,
    limit,
    `SELECT a.id, a.title, a.source_path, a.created_at, a.duration_ms,
            au.file_path, a.tags_json,
            (SELECT count(*) FROM chunks c JOIN transcripts t ON t.id = c.transcript_id
              WHERE t.asset_id = a.id) AS chunks,
            (SELECT count(*) FROM transcript_sentences s JOIN transcripts t ON t.id = s.transcript_id
              WHERE t.asset_id = a.id) AS sentences,
            a.collection_id, c.name AS collection_name
     FROM assets a JOIN audio_files au ON au.asset_id = a.id
     JOIN collections c ON c.id = a.collection_id
     WHERE a.kind = 'audio' ${scope} ${where.sql} ORDER BY a.id DESC`,
      `SELECT count(*) AS n
       FROM assets a JOIN audio_files au ON au.asset_id = a.id
       JOIN collections c ON c.id = a.collection_id
       WHERE a.kind = 'audio' ${scope} ${where.sql}`,
    )
    : EMPTY_PAGE

  return {
    allCollections: collectionId === ALL_COLLECTIONS,
    counts,
    total: {
      video: video.total,
      image: image.total,
      audio: audio.total,
      text: text.total,
    },
    hasMore: {
      video: video.rows.length < video.total,
      image: image.rows.length < image.total,
      audio: audio.rows.length < audio.total,
      text: text.rows.length < text.total,
    },
    video: video.rows.map((v) => ({
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
      tags: loadTags(v.tags_json),
    })),
    image: image.rows.map((im) => ({
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
      tags: loadTags(im.tags_json),
    })),
    audio: audio.rows.map((au) => ({
      id: au.id,
      collectionId: au.collection_id,
      collectionName: au.collection_name,
      title: au.title,
      sourcePath: au.source_path,
      createdAt: au.created_at,
      // 时长给音频播放器与卡片上的时长位；NULL 时前端显示 0:00，不显示「未知」——
      // 一个空时长几乎只发生在零句转写，那时显示未知比显示 0:00 更让人困惑。
      durationMs: au.duration_ms ?? 0,
      filePath: au.file_path,
      chunks: au.chunks,
      sentences: au.sentences,
      tags: loadTags(au.tags_json),
    })),
    text: text.rows.map((t) => ({
      id: t.id,
      collectionId: t.collection_id,
      collectionName: t.collection_name,
      title: t.title,
      sourcePath: t.source_path,
      createdAt: t.created_at,
      chars: t.chars,
      // 列表里的内联编辑要拿现有正文预填。**不传的代价是用户一保存就把正文
      // 清空**：空串与「没改」在 PATCH 里不是一回事，见 LibraryEditButton。
      content: t.content,
      hasVector: Boolean(t.has_vec),
      tags: loadTags(t.tags_json),
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

/**
 * 音频详情。文件路径从 audio_files 取，duration 从 assets.duration_ms 取。
 *
 * 逐字稿那一套直接照搬视频的查询：transcripts / transcript_sentences / chunks
 * 三张表都按 asset_id 关联，与 kind 无关。这也是 ingestAudio 只写这三张表的
 * 原因，读侧因此不需要为音频写第二套。
 */
export function getAudioDetail(id: number): AudioDetail | null {
  const db = getDb()
  const asset = db
    .prepare(
      'SELECT id, kind, title, source_path, duration_ms, created_at, meta_json, tags_json FROM assets WHERE id = ?',
    )
    .get(id) as
    | {
        id: number
        kind: string
        title: string
        source_path: string | null
        duration_ms: number | null
        created_at: string
        meta_json: string | null
        tags_json: string | null
      }
    | undefined

  if (!asset || asset.kind !== 'audio') return null

  const file = db
    .prepare('SELECT file_path, duration_ms FROM audio_files WHERE asset_id = ?')
    .get(id) as { file_path: string | null; duration_ms: number | null } | undefined

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
    text: string
    chunk_strategy: string
    sent_count: number
  }> = []

  if (transcript) {
    sentences = db
      .prepare(
        `SELECT s.start_ms, s.end_ms, s.text FROM transcript_sentences s
         JOIN transcripts t ON t.id = s.transcript_id WHERE t.asset_id = ?
         ORDER BY s.start_ms`,
      )
      .all(id) as Array<{ start_ms: number; end_ms: number; text: string }>

    chunks = db
      .prepare(
        `SELECT c.id, c.start_ms, c.end_ms, c.text, c.chunk_strategy,
                (SELECT count(*) FROM sentences sn WHERE sn.chunk_id = c.id) AS sent_count
         FROM chunks c JOIN transcripts t ON t.id = c.transcript_id WHERE t.asset_id = ?
         ORDER BY c.chunk_index`,
      )
      .all(id) as Array<{
      id: number
      start_ms: number
      end_ms: number
      text: string
      chunk_strategy: string
      sent_count: number
    }>
  }

  return {
    asset: {
      id: asset.id,
      title: asset.title,
      sourcePath: asset.source_path,
      createdAt: asset.created_at,
      meta: asset.meta_json ? (JSON.parse(asset.meta_json) as Record<string, unknown>) : {},
    },
    audioUrl: toMediaUrl(file?.file_path ?? null),
    durationMs: file?.duration_ms ?? asset.duration_ms,
    tags: loadTags(asset.tags_json),
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
  }
}

export function getVideoDetail(id: number): VideoDetail | null {
  const db = getDb()
  const asset = db
    .prepare(
      'SELECT id, kind, title, source_path, duration_ms, created_at, meta_json FROM assets WHERE id = ?',
    )
    .get(id) as
    | {
        id: number
        kind: string
        title: string
        source_path: string | null
        duration_ms: number | null
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
      durationMs: asset.duration_ms,
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
  kind: 'video' | 'image' | 'audio' | 'text'
  title: string
  caption: string | null
  createdAt: string
  /** 列表用小图，视频取首帧、图片取自身 */
  thumbUrl: string | null
  /** 详情页地址，三种模态各自一条 */
  detailHref: string
}

/**
 * 素材详情页地址。**四种模态各一条，加模态只改这里。**
 *
 * 曾有三处各写一遍（最近入库、结果列表、素材库列表），加模态时漏一处的表现是
 * 那一类素材在某个列表里点不动——不是报错，是链接指向一个不存在的路由，浏览器
 * 给 404。
 */
export function detailHrefFor(kind: string, id: number): string {
  if (kind === 'video') return `/library/video/${id}`
  if (kind === 'image') return `/library/image/${id}`
  if (kind === 'audio') return `/library/audio/${id}`
  return `/library/text/${id}`
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
  kind?: 'video' | 'image' | 'audio' | 'text',
): RecentAsset[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.title, a.created_at, im.caption, im.file_path,
              au.file_path AS audio_path,
              (SELECT f.thumb_path FROM frames f WHERE f.asset_id = a.id
                ORDER BY f.timestamp_ms LIMIT 1) AS cover
       FROM assets a LEFT JOIN images im ON im.asset_id = a.id
       LEFT JOIN audio_files au ON au.asset_id = a.id
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
    audio_path: string | null
    cover: string | null
  }>

  return rows.map((r) => {
    // 音频没有缩略图，thumbUrl 为 null。**不拿音频波形图冒充封面**：那要额外
    // 解码一次音频文件，而卡片上那一小块只是提示「库里有什么」，为它付一次
    // ffmpeg 调用不划算。音频卡片在列表里靠时长与句数表达自己。
    const thumb = r.kind === 'video' ? r.cover : r.kind === 'image' ? r.file_path : null
    return {
      id: r.id,
      kind: r.kind as RecentAsset['kind'],
      title: r.title,
      caption: r.caption,
      createdAt: r.created_at,
      thumbUrl: thumb ? toMediaUrl(thumb) : null,
      audioPath: r.audio_path,
      detailHref: detailHrefFor(r.kind, r.id),
    }
  })
}

/**
 * 文本素材详情。图片和视频早就有详情页，**文本一直没有，列表里也点不开**，
 * 于是用户入库的文本除了标题和字数，内容本身在界面上看不到，也无法编辑。
 * 这不只是少一个页面：文本的可编辑字段就是正文，没有详情页就没有编辑它的
 * 地方，只能改数据库。
 */
export function getTextDetail(id: number): TextDetail | null {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT a.id, a.title, a.created_at, n.content, n.embedding
       FROM assets a JOIN text_notes n ON n.asset_id = a.id WHERE a.id = ?`,
    )
    .get(id) as
    | {
        id: number
        title: string
        created_at: string
        content: string
        embedding: Buffer | null
      }
    | undefined

  if (!row) return null

  return {
    asset: {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      content: row.content,
      chars: row.content.length,
      hasVector: Boolean(row.embedding),
    },
  }
}
