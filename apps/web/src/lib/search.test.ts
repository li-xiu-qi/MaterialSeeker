import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AssetKind } from './mediaKind'

const encodeText = vi.fn(async () => [new Float32Array(768).fill(0.25)])
const embeddingState = { enabled: true }

vi.mock('./embed', () => ({
  encodeBatch: vi.fn(),
  encodeText,
  embeddingEnabled: () => embeddingState.enabled,
  PASSAGE_INSTRUCTION: 'passage: ',
}))

let dataDir: string
let db: Database | undefined
let vector: Buffer

beforeEach(async () => {
  embeddingState.enabled = true
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialseeker-search-'))
  process.env.MATERIALSEEKER_DATA_DIR = dataDir
  process.env.MATERIALSEEKER_PROFILE = 'standard'
  vi.resetModules()
  const dbModule = await import('./db')
  db = dbModule.getDb()
  vector = dbModule.embeddingToBlob(new Float32Array(768).fill(0.25))

  for (const kind of ['video', 'audio', 'text'] as const) {
    addChunkAsset(kind, `${kind}-城市素材`)
  }
  addFrame('video', 'video-frame.jpg')
  // 故意给音频放一帧脏数据：模态过滤不能依赖「正常数据里音频没有帧」这个假设。
  addFrame('audio', 'audio-frame.jpg')

  const imageId = asset('image', '城市图片')
  db.prepare(
    'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, ?, ?, ?)',
  ).run(imageId, 'city.png', '城市建筑照片', vector, vector)
  addAudioVectorAsset()
}, 30000)

afterEach(() => {
  embeddingState.enabled = true
  db?.close()
  db = undefined
  fs.rmSync(dataDir, { recursive: true, force: true })
  encodeText.mockClear()
})

function asset(kind: AssetKind, title: string): number {
  if (!db) throw new Error('测试数据库尚未初始化')
  return Number(
    db.prepare('INSERT INTO assets (kind, title, collection_id) VALUES (?, ?, 1)').run(kind, title)
      .lastInsertRowid,
  )
}

function addChunkAsset(kind: AssetKind, title: string): void {
  if (!db) throw new Error('测试数据库尚未初始化')
  const assetId = asset(kind, title)
  const transcriptId = Number(
    db.prepare('INSERT INTO transcripts (asset_id, full_text) VALUES (?, ?)').run(assetId, '城市建筑与滑板')
      .lastInsertRowid,
  )
  db.prepare(
    'INSERT INTO chunks (transcript_id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding) VALUES (?, 0, 0, 1000, ?, ?, ?)',
  ).run(transcriptId, '城市建筑与滑板', 'greedy', vector)
}

function addFrame(kind: 'video' | 'audio', file: string): void {
  if (!db) throw new Error('测试数据库尚未初始化')
  const row = db.prepare('SELECT id FROM assets WHERE kind = ? LIMIT 1').get(kind) as { id: number }
  db.prepare(
    'INSERT INTO frames (asset_id, timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index) VALUES (?, 0, ?, ?, ?, ?, 0)',
  ).run(row.id, file, '城市建筑画面', vector, vector)
}

/**
 * 音频文件向量。**故意不给它任何转写 chunk**：这样音频向量路命中时不可能
 * 是逐字稿路冒充的，模态边界的断言才真正落在 audio_files.embedding 上。
 */
function addAudioVectorAsset(): void {
  if (!db) throw new Error('测试数据库尚未初始化')
  const assetId = asset('audio', '城市环境音')
  db.prepare(
    'INSERT INTO audio_files (asset_id, file_path, duration_ms, embedding) VALUES (?, ?, ?, ?)',
  ).run(assetId, 'city.wav', 5000, vector)
}

describe('标准档检索的模态边界', () => {
  it.each(['video', 'audio', 'text'] as const)('%s 只返回自己的逐字稿，向量与中文关键词路都可用', async (modality) => {
    const { search } = await import('./search')
    const hits = await search('城市建筑', { modality })
    const chunks = hits.filter((hit) => hit.type === 'chunk')

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((hit) => hit.assetKind === modality)).toBe(true)
    expect(new Set(chunks.map((hit) => hit.source))).toEqual(new Set(['vector', 'keyword']))
    // audio 现在还会多一路音频文件向量，这里只钉「文本没有别的形态」；
    // 音频向量的边界由下面的专项断言覆盖。
    if (modality === 'text') {
      expect(hits.every((hit) => hit.type === 'chunk')).toBe(true)
    }
  }, 30000)

  it.each(['video', 'all'] as const)('%s 的帧结果不包含音频脏帧', async (modality) => {
    const { search } = await import('./search')
    const hits = await search('城市建筑', { modality })
    const frames = hits.filter((hit) => hit.type === 'frame')

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((hit) => hit.thumbPath === 'video-frame.jpg')).toBe(true)
    expect(new Set(frames.map((hit) => hit.source))).toEqual(
      new Set(['frame_vector', 'caption_vector']),
    )
  })

  it.each(['video', 'all'] as const)('%s 的轻量关键词帧结果不包含音频脏帧', async (modality) => {
    embeddingState.enabled = false
    const { search } = await import('./search')
    const hits = await search('城市建筑', { modality })
    const frames = hits.filter((hit) => hit.type === 'frame')

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((hit) => hit.thumbPath === 'video-frame.jpg')).toBe(true)
    expect(frames.every((hit) => hit.source === 'keyword')).toBe(true)
  })

  it('image 不混入逐字稿或视频帧', async () => {
    const { search } = await import('./search')
    const hits = await search('城市建筑', { modality: 'image' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.type === 'image')).toBe(true)
  })

  it('audio 模态同时返回逐字稿与音频文件向量，且音频向量不泄漏到其他模态', async () => {
    const { search } = await import('./search')
    const hits = await search('城市建筑', { modality: 'audio' })
    const audioHits = hits.filter((hit) => hit.type === 'audio')

    expect(audioHits.length).toBeGreaterThan(0)
    expect(audioHits.every((hit) => hit.source === 'audio_vector')).toBe(true)
    expect(audioHits.every((hit) => hit.filePath === 'city.wav')).toBe(true)
    expect(hits.filter((hit) => hit.type === 'chunk').every((hit) => hit.assetKind === 'audio')).toBe(
      true,
    )

    for (const modality of ['video', 'image', 'text'] as const) {
      const scoped = await search('城市建筑', { modality })
      expect(scoped.every((hit) => hit.type !== 'audio')).toBe(true)
    }
  }, 30000)

  it('all 模态包含音频文件向量结果', async () => {
    const { search } = await import('./search')
    const hits = await search('城市建筑', { modality: 'all' })
    expect(hits.some((hit) => hit.type === 'audio' && hit.source === 'audio_vector')).toBe(true)
  })
})
