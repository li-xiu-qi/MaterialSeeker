import fs from 'node:fs'
import path from 'node:path'

import { getDb, embeddingToBlob } from './db'
import { PATHS } from './paths'
import { encodeBatch, embeddingEnabled, PASSAGE_INSTRUCTION } from './embed'
import { chunkGreedy } from './chunking'
import { DEFAULT_COLLECTION_ID } from './collections'
import { generateThumbs } from './thumbs'
import { composeCaptionText, parseTags, serializeTags } from './tags'

/**
 * 文本入库（M1 唯一打通的入库路径）。
 *
 * 一条文本笔记变成一个 text asset，内容按 greedy 切块（默认 2000 字符），
 * 每块单独编码入库，嵌带入库侧 instruction。文本笔记通常不长，多数情况
 * 只有一块，但切块逻辑先跑通，视频入库直接复用。
 */
export async function ingestText(
  title: string,
  content: string,
  collectionId: number = DEFAULT_COLLECTION_ID,
): Promise<number> {
  const db = getDb()

  const sentences = [{ start_ms: 0, end_ms: 0, text: content }]
  const chunks = chunkGreedy(sentences)

  // 标准版批量编码；轻量版跳过模型调用，FTS 仍由数据库触发器维护。
  const useEmbedding = embeddingEnabled()
  const vectors = useEmbedding
    ? await encodeBatch({
        inputs: chunks.map((c) => ({
          modality: 'text' as const,
          text: c.text,
          instruction: PASSAGE_INSTRUCTION,
        })),
      })
    : []
  if (useEmbedding && vectors.length !== chunks.length) {
    throw new Error(`encode mismatch: ${vectors.length} vectors for ${chunks.length} chunks`)
  }

  const insertAsset = db
    .prepare(
      'INSERT INTO assets (kind, title, source_path, meta_json, collection_id) VALUES (?, ?, ?, ?, ?)',
    )
    .run('text', title, null, JSON.stringify({ bytes: content.length }), collectionId)
  const assetId = Number(insertAsset.lastInsertRowid)

  const insertTranscript = db
    .prepare('INSERT INTO transcripts (asset_id, full_text, language, asr_engine) VALUES (?, ?, ?, ?)')
    .run(assetId, content, 'zh', 'import')
  const transcriptId = Number(insertTranscript.lastInsertRowid)

  db
    .prepare('INSERT INTO text_notes (asset_id, content, embedding) VALUES (?, ?, ?)')
    .run(assetId, content, vectors[0] ? embeddingToBlob(vectors[0]) : null)

  const insertChunk = db.prepare(
    `INSERT INTO chunks (transcript_id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertSentence = db.prepare(
    'INSERT INTO sentences (chunk_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)',
  )

  const tx = db.transaction(() => {
    chunks.forEach((c, i) => {
      const r = insertChunk.run(
        transcriptId,
        c.chunk_index,
        c.start_ms,
        c.end_ms,
        c.text,
        c.strategy,
        vectors[i] ? embeddingToBlob(vectors[i]) : null,
      )
      const chunkId = Number(r.lastInsertRowid)
      for (const s of c.sentences) {
        insertSentence.run(chunkId, s.start_ms, s.end_ms, s.text)
      }
    })
  })
  tx()

  return assetId
}

/**
 * 图片入库。一份图片入库变成一个 image asset 加一条 images 记录。
 *
 * 图片带双重表示：图片本身的向量，加上说明文本的向量。说明文本来自
 * VLM 生成（当前由调用方传入，M3 的 VLM 生成路径见 PRD 开放问题 2），
 * 没有说明文本时只有图片向量一路可检索。
 *
 * 图片文件不复制，直接记录源路径。素材库在自己机器上，复制一份只会让
 * 同一份图存两处、还多占一倍空间。
 */
export async function ingestImage(
  title: string,
  filePath: string,
  caption?: string,
  collectionId: number = DEFAULT_COLLECTION_ID,
  tags: string[] = [],
): Promise<number> {
  const db = getDb()
  const tagList = parseTags(tags)
  // **标签拼进说明文本一起编码**，理由见 tags.ts。没有说明也没有标签时这路
  // 向量仍是 NULL，检索侧按 IS NOT NULL 筛，行为与原来一致。
  const captionText = composeCaptionText(caption, tagList)

  const inputs: Array<
    | { modality: 'image'; path: string }
    | { modality: 'text'; text: string; instruction: string }
  > = [{ modality: 'image', path: filePath }]
  if (captionText) {
    inputs.push({ modality: 'text', text: captionText, instruction: PASSAGE_INSTRUCTION })
  }
  const useEmbedding = embeddingEnabled()
  const vectors = useEmbedding ? await encodeBatch({ inputs }) : []
  const imgVec = useEmbedding ? vectors[0] : null
  const capVec = useEmbedding && captionText ? vectors[1] : null

  const insertAsset = db
    .prepare(
      'INSERT INTO assets (kind, title, source_path, meta_json, collection_id, tags_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      'image',
      title,
      filePath,
      JSON.stringify({ has_caption: Boolean(caption), has_tags: tagList.length > 0 }),
      collectionId,
      serializeTags(tagList),
    )
  const assetId = Number(insertAsset.lastInsertRowid)

  db.prepare(
    'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, ?, ?, ?)',
  ).run(
    assetId,
    filePath,
    caption ?? null,
    imgVec ? embeddingToBlob(imgVec) : null,
    capVec ? embeddingToBlob(capVec) : null,
  )

  // 顺手把缩略图预热掉。**此时不预热，这笔账就记在第一次浏览的人头上**：实测未命中
  // 的 resize 是 107ms，命中是 4-8ms，差 15 倍；一次刷 24 张卡片就是二十多个未命中
  // 并发，累积起来就是「素材库加载有点卡」。入库这条路径本来就要读原图，多产出三档
  // 缩略图的总耗时增加有限。
  // 不 await 失败：缩略图是优化项，路由那一侧有按需生成的兜底，为它中断入库不划算。
  void generateThumbs(filePath).catch(() => {})

  return assetId
}

/**
 * 上传落地：把浏览器传来的文件写进素材目录，返回服务端绝对路径。
 *
 * 上传与编码分开。上传只负责落盘与生成 asset 占位记录，编码与抽帧在
 * 后续步骤做（视频入库是分钟级任务，不能堵在 HTTP 请求里）。
 */

/** 落盘到 <dataDir>/<kind>/<日期>_<原文件名>，重名自动加序号 */
export async function stageUpload(
  kind: 'image' | 'video',
  originalName: string,
  bytes: Buffer,
  collectionId: number = DEFAULT_COLLECTION_ID,
): Promise<{ path: string; assetId: number }> {
  const db = getDb()
  const dir = kind === 'image' ? PATHS.imagesDir : PATHS.videosDir
  const safe = originalName.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_')
  let target = path.join(dir, safe)
  let n = 1
  while (fs.existsSync(target)) {
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    target = path.join(dir, `${stem}_${n}${ext}`)
    n += 1
  }
  fs.writeFileSync(target, bytes)

  const info = db
    .prepare(
      'INSERT INTO assets (kind, title, source_path, meta_json, collection_id) VALUES (?, ?, ?, ?, ?)',
    )
    .run(kind, safe, target, JSON.stringify({ staged: true, bytes: bytes.length }), collectionId)

  return { path: target, assetId: Number(info.lastInsertRowid) }
}
