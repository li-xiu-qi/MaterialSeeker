import { getDb, embeddingToBlob } from './db'
import type { Database } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { encodeBatch, PASSAGE_INSTRUCTION } from './embed'
import { composeCaptionText, parseTags, serializeTags } from './tags'

/**
 * 素材库（collection）的增删查与作用域。
 *
 * 库存在的理由是检索作用域：没有它每次检索都是全表，素材一多就只有变慢
 * 一条路。一个素材归属且只归属一个库，这是刻意的简化，多归属看着灵活，
 * 实际会把「这个素材到底算哪边的」变成每次都要重新判断的问题。
 *
 * 默认库 id 固定为 1（见 db.ts 的 migrateCollections），不允许删：删了它
 * 存量素材的 collection_id 就悬空，而默认库恰恰是兜底的那个。
 */

export const DEFAULT_COLLECTION_ID = 1

/**
 * 「全部库」的哨兵值。用 0 而不是 null 或字符串，是因为它要能和普通 id 一样
 * 流经 SQL 参数与 URL 查询串，0 不可能与自增主键撞上。
 */
export const ALL_COLLECTIONS = 0

export interface Collection {
  id: number
  name: string
  createdAt: string
  video: number
  image: number
  text: number
}

export function listCollections(): Collection[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.created_at,
              (SELECT count(*) FROM assets a WHERE a.collection_id = c.id AND a.kind='video') AS video,
              (SELECT count(*) FROM assets a WHERE a.collection_id = c.id AND a.kind='image') AS image,
              (SELECT count(*) FROM assets a WHERE a.collection_id = c.id AND a.kind='text') AS text
       FROM collections c ORDER BY c.id`,
    )
    .all() as Array<{
    id: number
    name: string
    created_at: string
    video: number
    image: number
    text: number
  }>

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    video: r.video,
    image: r.image,
    text: r.text,
  }))
}

export function getCollection(id: number): Collection | null {
  return listCollections().find((c) => c.id === id) ?? null
}

/** 素材总数，用于判断一个库是不是空的 */
export function collectionSize(id: number): number {
  const db = getDb()
  const row = db
    .prepare('SELECT count(*) AS n FROM assets WHERE collection_id = ?')
    .get(id) as { n: number }
  return row.n
}

export function createCollection(name: string): number {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('素材库名称不能为空')
  if (trimmed.length > 40) throw new Error('素材库名称太长（上限 40 字）')

  const db = getDb()
  const exist = db.prepare('SELECT id FROM collections WHERE name = ?').get(trimmed) as
    | { id: number }
    | undefined
  if (exist) throw new Error(`已存在同名素材库「${trimmed}」`)

  const r = db.prepare('INSERT INTO collections (name) VALUES (?)').run(trimmed)
  return Number(r.lastInsertRowid)
}

export function renameCollection(id: number, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('素材库名称不能为空')
  const db = getDb()
  const exist = db.prepare('SELECT id FROM collections WHERE name = ? AND id != ?').get(trimmed, id)
  if (exist) throw new Error(`已存在同名素材库「${trimmed}」`)
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(trimmed, id)
}

/**
 * 删素材库，**非空时级联删掉里面素材的索引记录**。
 *
 * 原先只允许删空库，要求用户先把素材一条条移走。那个要求不现实：素材多时
 * 等于不让删库。改为级联删除，确认框里讲清后果。
 *
 * **级联只删索引记录，不动磁盘文件。** 理由是硬的：视频可能是用户自己拍的，
 * 网站资源能重新下载，自己录的素材重新拿不回来，级联删文件一旦误点不可逆。
 * 删记录有反悔余地，文件还在素材目录，重新入库即可恢复可检索状态。代价是
 * 会留下无记录的孤立文件，这是用安全换的。
 */
export function deleteCollection(id: number): { removedAssets: number } {
  if (id === DEFAULT_COLLECTION_ID) throw new Error('默认库不能删除')
  const db = getDb()

  // 不存在的 id 要报错，不能静默成功。否则界面上会显示「已删除 X」而 X 从未存在，
  // 用户无法区分真删了和根本没这个库。
  const exist = db.prepare('SELECT id FROM collections WHERE id = ?').get(id)
  if (!exist) throw new Error('素材库不存在')

  const ids = db
    .prepare('SELECT id, kind FROM assets WHERE collection_id = ?')
    .all(id) as Array<{ id: number; kind: string }>

  const tx = db.transaction(() => {
    for (const a of ids) removeAssetRecords(db, a.id, a.kind)
    db.prepare('DELETE FROM collections WHERE id = ?').run(id)
  })
  tx()

  return { removedAssets: ids.length }
}

/**
 * 摘掉一个素材的全部索引记录。与 DELETE /api/library/[id] 同一套逻辑，
 * 抽出来是为了让删库级联与单条删除走同一条路——两处各写一遍，某一边漏删
 * 一张子表不会报错，只会留下查不到的孤儿行。
 *
 * 只删记录，不碰文件。
 */
export function removeAssetRecords(db: Database, id: number, kind: string): void {
  // 音频与视频同样有逐字稿（transcripts/chunks/sentences），删的时候要一起清。
  // **两者写在同一行是刻意的**：它们共用这三张表，分两条 if 写的结果是将来
  // 给音频加第五种子表时只改一条，而漏改的那条不报错，只留下孤儿行。
  if (kind === 'video' || kind === 'audio') {
    const tids = db.prepare('SELECT id FROM transcripts WHERE asset_id = ?').all(id) as Array<{
      id: number
    }>
    for (const t of tids) {
      db
        .prepare(
          'DELETE FROM sentences WHERE chunk_id IN (SELECT id FROM chunks WHERE transcript_id = ?)',
        )
        .run(t.id)
      db.prepare('DELETE FROM chunks WHERE transcript_id = ?').run(t.id)
      db.prepare('DELETE FROM transcript_sentences WHERE transcript_id = ?').run(t.id)
    }
    db.prepare('DELETE FROM transcripts WHERE asset_id = ?').run(id)
  }
  if (kind === 'video' || kind === 'image') {
    db.prepare('DELETE FROM frames WHERE asset_id = ?').run(id)
  }
  if (kind === 'image') db.prepare('DELETE FROM images WHERE asset_id = ?').run(id)
  if (kind === 'text') db.prepare('DELETE FROM text_notes WHERE asset_id = ?').run(id)
  if (kind === 'audio') db.prepare('DELETE FROM audio_files WHERE asset_id = ?').run(id)
  db.prepare('DELETE FROM assets WHERE id = ?').run(id)
}

/**
 * 把素材搬到另一个库。**只改 collection_id，不碰磁盘文件。**
 *
 * 文件是按类型放在 dataDir/<kind>/ 下的，不按库分目录（见 paths.ts），所以
 * 换库不影响任何一条 file_path 的有效性。这也是移动敢做成纯 SQL 的原因：
 * 不搬文件就没有搬一半失败的状态。
 *
 * 返回实际改动的行数。目标库就是素材当前所在的库时，changes 为 0，调用方
 * 要能区分「搬了 0 条」和「搬了 3 条」，不能一律显示成功。
 */
export function moveAssets(db: Database, ids: number[], toId: number): number {
  if (ids.length === 0) return 0
  const ph = ids.map(() => '?').join(',')
  const info = db
    .prepare(`UPDATE assets SET collection_id = ? WHERE id IN (${ph})`)
    .run(toId, ...ids)
  return info.changes
}

/**
 * 复制素材到另一个库。**磁盘文件真的复制一份**，两份记录各指向自己的文件。
 *
 * 用户选的是真复制而不是共用同一文件：共用在改文件时会两边一起变，而复制
 * 出来的那份本该是独立的。代价是体积翻倍，且删库仍然不删文件，会留下更多
 * 无主文件（这条既定规则不变）。
 *
 * **帧缩略图不复制，两份记录共用。** thumb_path 是从视频抽出来的派生数据，
 * 用户不会去编辑它，复制一份纯占盘；删库本来就不删文件，共用也没有 delete
 * 时一边失效的问题。主文件与派生数据区别对待，别照搬「都复制」。
 *
 * 子表逐层复制，**新增主键重新生成**：assets、transcripts、chunks、
 * sentences、transcript_sentences、frames、images、text_notes 都要复制。
 * chunks_fts 由 AFTER INSERT 触发器自动同步，不用手动插。
 *
 * 本函数与 removeAssetRecords 是镜像关系：那边删掉哪些表，这边就要复制哪些
 * 表。改一处不改另一处，结果是复制出来的素材缺一半数据，而缺数据不报错，
 * 只表现为检索时少命中、详情页空白。所以两张表要一起看。
 */
export function copyAssets(db: Database, ids: number[], toId: number): number {
  if (ids.length === 0) return 0

  /** 把文件复制到同目录下的新名字，重名自动加序号。返回 null 表示没有主文件（文本）。 */
  const duplicateFile = (src: string | null): string | null => {
    if (!src || !fs.existsSync(src)) return null
    const ext = path.extname(src)
    const stem = path.basename(src, ext)
    const dir = path.dirname(src)
    let n = 1
    let target = path.join(dir, `${stem}_copy${ext}`)
    while (fs.existsSync(target)) {
      target = path.join(dir, `${stem}_copy${n}${ext}`)
      n += 1
    }
    fs.copyFileSync(src, target)
    return target
  }

  const tx = db.transaction(() => {
    let done = 0
    for (const id of ids) {
      const a = db
        .prepare('SELECT kind, title, source_path, duration_ms, meta_json FROM assets WHERE id = ?')
        .get(id) as
        | { kind: string; title: string; source_path: string | null; duration_ms: number | null; meta_json: string | null }
        | undefined
      if (!a) continue

      // 主文件：图片取 images.file_path（库内副本），视频取 source_path（库里那份）。
      // 与 export 路由同一个理由：source_path 对图片记的是外部来源，早已不存在。
      let primary: string | null = null
      if (a.kind === 'image') {
        const row = db
          .prepare('SELECT file_path FROM images WHERE asset_id = ?')
          .get(id) as { file_path: string } | undefined
        primary = row?.file_path ?? null
      } else if (a.kind === 'video') {
        primary = a.source_path
      }
      const newPrimary = duplicateFile(primary)

      const meta = (() => {
        try {
          const m = a.meta_json ? JSON.parse(a.meta_json) : {}
          return typeof m === 'object' && m !== null ? { ...m, copiedFrom: id } : { copiedFrom: id }
        } catch {
          return { copiedFrom: id }
        }
      })()

      const inserted = db
        .prepare(
          'INSERT INTO assets (kind, title, source_path, duration_ms, meta_json, collection_id) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(a.kind, a.title, newPrimary ?? a.source_path, a.duration_ms, JSON.stringify(meta), toId)
      const newId = Number(inserted.lastInsertRowid)
      done += 1

      if (a.kind === 'video') {
        const txs = db
          .prepare('SELECT id, full_text, language, asr_engine FROM transcripts WHERE asset_id = ?')
          .all(id) as Array<{ id: number; full_text: string; language: string | null; asr_engine: string | null }>
        for (const t of txs) {
          const nt = db
            .prepare('INSERT INTO transcripts (asset_id, full_text, language, asr_engine) VALUES (?, ?, ?, ?)')
            .run(newId, t.full_text, t.language, t.asr_engine)
          const newTid = Number(nt.lastInsertRowid)

          // 句子流：全片时间轴那条，跟着 transcript 换 id
          const tsents = db
            .prepare('SELECT start_ms, end_ms, text FROM transcript_sentences WHERE transcript_id = ?')
            .all(t.id) as Array<{ start_ms: number; end_ms: number; text: string }>
          for (const s of tsents) {
            db.prepare('INSERT INTO transcript_sentences (transcript_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)')
              .run(newTid, s.start_ms, s.end_ms, s.text)
          }

          // chunk 与它下属的 sentences：两层都要重新映射 id，嵌错了不会报错
          const chunks = db
            .prepare('SELECT id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding FROM chunks WHERE transcript_id = ?')
            .all(t.id) as Array<{
            id: number
            chunk_index: number
            start_ms: number
            end_ms: number
            text: string
            chunk_strategy: string
            embedding: Buffer | null
          }>
          for (const c of chunks) {
            const nc = db
              .prepare(
                `INSERT INTO chunks (transcript_id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(newTid, c.chunk_index, c.start_ms, c.end_ms, c.text, c.chunk_strategy, c.embedding)
            const newCid = Number(nc.lastInsertRowid)
            const sents = db
              .prepare('SELECT start_ms, end_ms, text FROM sentences WHERE chunk_id = ?')
              .all(c.id) as Array<{ start_ms: number; end_ms: number; text: string }>
            for (const s of sents) {
              db.prepare('INSERT INTO sentences (chunk_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)')
                .run(newCid, s.start_ms, s.end_ms, s.text)
            }
          }
        }
      }

      // 帧：视频与图片都有。thumb_path 共用（见函数注释），embedding 复制
      const frames = db
        .prepare(
          'SELECT timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index FROM frames WHERE asset_id = ?',
        )
        .all(id) as Array<{
        timestamp_ms: number
        thumb_path: string | null
        caption: string | null
        embedding: Buffer | null
        caption_embedding: Buffer | null
        scene_index: number | null
      }>
      for (const f of frames) {
        db.prepare(
          `INSERT INTO frames (asset_id, timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(newId, f.timestamp_ms, f.thumb_path, f.caption, f.embedding, f.caption_embedding, f.scene_index)
      }

      if (a.kind === 'image') {
        const im = db
          .prepare('SELECT caption, embedding, caption_embedding FROM images WHERE asset_id = ?')
          .get(id) as { caption: string | null; embedding: Buffer | null; caption_embedding: Buffer | null } | undefined
        if (im) {
          db.prepare(
            'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, ?, ?, ?)',
          ).run(newId, newPrimary, im.caption, im.embedding, im.caption_embedding)
        }
      }

      if (a.kind === 'text') {
        const tn = db
          .prepare('SELECT content, embedding FROM text_notes WHERE asset_id = ?')
          .get(id) as { content: string; embedding: Buffer | null } | undefined
        if (tn) {
          db.prepare('INSERT INTO text_notes (asset_id, content, embedding) VALUES (?, ?, ?)').run(
            newId,
            tn.content,
            tn.embedding,
          )
        }
      }
    }
    return done
  })

  return tx()
}

/**
 * 校验作用域参数。前端传来的 lib 可能是任意字符串，这里归一成合法值。
 * 'all' 归一成 ALL_COLLECTIONS，其余非法值一律回落到默认库——不让它变成
 * SQL 注入面，也不让它悄悄搜出空结果还查不出原因。
 */
export function normalizeCollectionId(raw: string | number | undefined | null): number {
  if (raw === 'all') return ALL_COLLECTIONS
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COLLECTION_ID
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_COLLECTION_ID
  return getCollection(n) ? n : DEFAULT_COLLECTION_ID
}

/**
 * 作用域的 SQL 条件与参数。**所有按库过滤的查询都用这两个函数**，不要各自
 * 拼字符串：拼漏一次就是「选了全部却还在按库过滤」，而这种错不会有任何报错，
 * 只是结果莫名变少，属于最难查的那类。
 */
export function scopeClause(collectionId: number): string {
  return collectionId === ALL_COLLECTIONS ? '' : 'AND a.collection_id = ?'
}

export function scopeArgs(collectionId: number): number[] {
  return collectionId === ALL_COLLECTIONS ? [] : [collectionId]
}

/** 作用域的展示名，界面与文案共用 */
export function scopeLabel(collectionId: number): string {
  if (collectionId === ALL_COLLECTIONS) return '全部库'
  return getCollection(collectionId)?.name ?? '默认库'
}

/**
 * 改素材的标题与标注。**改标注必须重新编码，否则新描述搜不到。**
 *
 * 标注明明改了却没重编码，是那种不报错、只在检索时表现为「按新描述搜不到」
 * 的失效：库里存的还是旧向量，用户看到描述已更新，会以为检索坏了。所以
 * caption 一有变化就走编码服务，跟入库时同一条路（PASSAGE_INSTRUCTION）。
 *
 * 三类素材的可编辑面不一样，这是数据模型决定的，不是懒得做：
 * - 图片：caption 存在 images.caption，配 images.caption_embedding，可改可重编码。
 * - 文本：正文存在 text_notes.content，配 text_notes.embedding，同理。
 * - 视频：没有「整片一个描述」这个字段。视频的描述在 frames.caption 上，是逐帧
 *   的，改一个不影响其他帧，所以不支持整片批量改；帧描述在各帧上单独改。
 *
 * 三类素材都能整片改标签（tags 存 assets.tags_json，与 kind 无关）。视频帧上的
 * 描述仍是逐帧的，不在这个入口。
 *
 * 返回实际改了什么，调用方据此给反馈，不要一律显示「已保存」。
 */
export async function updateAssetMeta(
  id: number,
  patch: { title?: string; caption?: string; tags?: string[] },
): Promise<{ title: boolean; caption: boolean; tags: boolean }> {
  const db = getDb()
  const row = db.prepare('SELECT kind, tags_json FROM assets WHERE id = ?').get(id) as
    | { kind: string; tags_json: string | null }
    | undefined
  if (!row) throw new Error('素材不存在')

  let titleChanged = false
  let captionChanged = false
  let tagsChanged = false

  const nextTitle = patch.title?.trim()
  if (nextTitle) {
    db.prepare('UPDATE assets SET title = ? WHERE id = ?').run(nextTitle, id)
    titleChanged = true
  }

  const nextTags = patch.tags !== undefined ? parseTags(patch.tags) : null
  if (nextTags) {
    // 标签挂在 assets 上，三种素材通用（视频也能整片打标签，帧描述才是逐帧的）。
    db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(serializeTags(nextTags), id)
    tagsChanged = true
  }
  const curTags = nextTags ?? parseTags(row.tags_json)

  const nextCaption = patch.caption?.trim()
  if (nextCaption !== undefined) {
    if (row.kind === 'image') {
      const cur = db.prepare('SELECT caption FROM images WHERE asset_id = ?').get(id) as
        | { caption: string | null }
        | undefined
      if (!cur) throw new Error('图片记录缺失')
      if ((cur.caption ?? '') !== nextCaption) {
        // **重编码的语料是描述加当前标签，不是描述自己**。只编码描述的结果是
        // 改了描述之后标签词从语料里消失，之前靠标签搜得到的这条素材再也搜不到，
        // 而这个故障没有任何提示，只会被当成「检索模型不行」。
        const text = composeCaptionText(nextCaption, curTags)
        // 空语料也要清掉向量：留着旧向量会让这条素材继续被旧语料命中
        const vec = text
          ? (await encodeBatch({ inputs: [{ modality: 'text', text, instruction: PASSAGE_INSTRUCTION }] }))[0]
          : null
        db.prepare('UPDATE images SET caption = ?, caption_embedding = ? WHERE asset_id = ?').run(
          nextCaption || null,
          vec ? embeddingToBlob(vec) : null,
          id,
        )
        captionChanged = true
      }
    } else if (row.kind === 'text') {
      const cur = db.prepare('SELECT content FROM text_notes WHERE asset_id = ?').get(id) as
        | { content: string }
        | undefined
      if (!cur) throw new Error('文本记录缺失')
      if (cur.content !== nextCaption) {
        if (!nextCaption) throw new Error('正文不能为空')
        const vec = (
          await encodeBatch({
            inputs: [
              {
                modality: 'text',
                text: composeCaptionText(nextCaption, curTags),
                instruction: PASSAGE_INSTRUCTION,
              },
            ],
          })
        )[0]
        db.prepare('UPDATE text_notes SET content = ?, embedding = ? WHERE asset_id = ?').run(
          nextCaption,
          embeddingToBlob(vec),
          id,
        )
        captionChanged = true
      }
    } else {
      throw new Error('视频没有整片描述可改，帧描述请在关键帧上单独编辑')
    }
  } else if (nextTags) {
    // 只改标签、没带描述：图片那一路照样要重编码，否则标签是纯摆设。
    if (row.kind === 'image') {
      const cur = db.prepare('SELECT caption FROM images WHERE asset_id = ?').get(id) as
        | { caption: string | null }
        | undefined
      if (!cur) throw new Error('图片记录缺失')
      const text = composeCaptionText(cur.caption, nextTags)
      const vec = text
        ? (await encodeBatch({ inputs: [{ modality: 'text', text, instruction: PASSAGE_INSTRUCTION }] }))[0]
        : null
      db.prepare('UPDATE images SET caption_embedding = ? WHERE asset_id = ?').run(
        vec ? embeddingToBlob(vec) : null,
        id,
      )
    } else if (row.kind === 'text') {
      const cur = db.prepare('SELECT content FROM text_notes WHERE asset_id = ?').get(id) as
        | { content: string }
        | undefined
      if (!cur) throw new Error('文本记录缺失')
      const vec = await encodeBatch({
        inputs: [
          { modality: 'text', text: composeCaptionText(cur.content, nextTags), instruction: PASSAGE_INSTRUCTION },
        ],
      })
      db.prepare('UPDATE text_notes SET embedding = ? WHERE asset_id = ?').run(embeddingToBlob(vec[0]), id)
    }
  }

  return { title: titleChanged, caption: captionChanged, tags: tagsChanged }
}
