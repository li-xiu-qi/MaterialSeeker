import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'

const state = vi.hoisted(() => ({ enabled: true }))
const encodeBatch = vi.fn(async (req: { inputs: unknown[] }) =>
  req.inputs.map(() => new Float32Array(768).fill(0.25)),
)

vi.mock('./embed', () => ({
  encodeBatch,
  embeddingEnabled: () => state.enabled,
  PASSAGE_INSTRUCTION: 'passage: ',
}))

let dataDir: string
let db: Database

beforeEach(async () => {
  state.enabled = true
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialseeker-backfill-'))
  process.env.MATERIALSEEKER_DATA_DIR = dataDir
  process.env.MATERIALSEEKER_PROFILE = 'standard'
  vi.resetModules()
  db = (await import('./db')).getDb()
}, 30000)

afterEach(() => {
  // beforeEach 超时或失败时也不能让 close 的二次错误掩盖真正原因。
  db?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  encodeBatch.mockClear()
})

function asset(kind: string, title: string): number {
  return Number(
    db.prepare('INSERT INTO assets (kind, title, collection_id) VALUES (?, ?, 1)').run(kind, title)
      .lastInsertRowid,
  )
}

function getRow<T>(sql: string, ...params: unknown[]): T {
  return db.prepare(sql).get(...params) as T
}

describe('backfillEmbeddings', () => {
  it('回填所有向量字段，保留已有向量，第二次调用为空操作', async () => {
    const noteAsset = asset('text', '城市笔记')
    db.prepare('INSERT INTO text_notes (asset_id, content, embedding) VALUES (?, ?, NULL)').run(
      noteAsset,
      '滑板少年在城市建筑前表演',
    )

    const videoAsset = asset('video', '城市视频')
    const transcriptId = Number(
      db.prepare('INSERT INTO transcripts (asset_id, full_text) VALUES (?, ?)').run(videoAsset, '全文')
        .lastInsertRowid,
    )
    const { embeddingToBlob } = await import('./db')
    const existing = embeddingToBlob(new Float32Array(768).fill(0.75))
    db.prepare(
      'INSERT INTO chunks (transcript_id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding) VALUES (?, 0, 0, 1000, ?, ?, NULL)',
    ).run(transcriptId, '城市建筑与滑板', 'scene')
    db.prepare(
      'INSERT INTO chunks (transcript_id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding) VALUES (?, 1, 1000, 2000, ?, ?, ?)',
    ).run(transcriptId, '已有向量的段落', 'scene', existing)
    db.prepare(
      'INSERT INTO frames (asset_id, timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index) VALUES (?, 0, ?, ?, NULL, NULL, 0)',
    ).run(videoAsset, 'frame.jpg', '黄昏时的城市天际线')

    const imageAsset = asset('image', '屋顶照片')
    db.prepare(
      'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, ?, NULL, NULL)',
    ).run(imageAsset, 'roof.png', '红色屋顶与白色墙面')
    const noCaptionAsset = asset('image', '无描述图片')
    db.prepare(
      'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, NULL, NULL, NULL)',
    ).run(noCaptionAsset, 'blank.png')

    const { backfillEmbeddings } = await import('./backfill')
    const stats = await backfillEmbeddings({ batchSize: 1 })

    expect(stats).toEqual({
      textNotes: 1,
      chunks: 1,
      frameImages: 1,
      frameCaptions: 1,
      imageImages: 2,
      imageCaptions: 1,
      audioFiles: 0,
      batches: 7,
    })
    expect(
      getRow<{ embedding: Buffer | null }>('SELECT embedding FROM text_notes WHERE asset_id = ?', noteAsset).embedding,
    ).not.toBeNull()
    expect(
      getRow<{ embedding: Buffer | null }>('SELECT embedding FROM chunks WHERE transcript_id = ? AND chunk_index = 0', transcriptId).embedding,
    ).not.toBeNull()
    expect(
      getRow<{ embedding: Buffer }>('SELECT embedding FROM chunks WHERE transcript_id = ? AND chunk_index = 1', transcriptId).embedding.equals(existing),
    ).toBe(true)
    expect(
      getRow<{ embedding: Buffer | null }>('SELECT embedding, caption_embedding FROM frames WHERE asset_id = ?', videoAsset).embedding,
    ).not.toBeNull()
    expect(
      getRow<{ caption_embedding: Buffer | null }>('SELECT caption_embedding FROM images WHERE asset_id = ?', imageAsset).caption_embedding,
    ).not.toBeNull()
    expect(
      getRow<{ caption_embedding: Buffer | null }>('SELECT caption_embedding FROM images WHERE asset_id = ?', noCaptionAsset).caption_embedding,
    ).toBeNull()

    // 第二次调用不应再发任何编码请求，也不能覆盖已有向量。
    encodeBatch.mockClear()
    const second = await backfillEmbeddings()
    expect(second).toEqual({
      textNotes: 0,
      chunks: 0,
      frameImages: 0,
      frameCaptions: 0,
      imageImages: 0,
      imageCaptions: 0,
      audioFiles: 0,
      batches: 0,
    })
    expect(encodeBatch).not.toHaveBeenCalled()
  }, 30000)

  it('回填音频文件向量，不把它错当成转写文本', async () => {
    const audioAsset = asset('audio', '城市环境音')
    db.prepare(
      'INSERT INTO audio_files (asset_id, file_path, duration_ms, embedding) VALUES (?, ?, ?, NULL)',
    ).run(audioAsset, 'city.wav', 5000)

    const { backfillEmbeddings } = await import('./backfill')
    const stats = await backfillEmbeddings({ batchSize: 1 })
    expect(stats.audioFiles).toBe(1)
    expect(
      getRow<{ embedding: Buffer | null }>('SELECT embedding FROM audio_files WHERE asset_id = ?', audioAsset)
        .embedding,
    ).not.toBeNull()

    const audioInputs = encodeBatch.mock.calls
      .flatMap(([req]) => req.inputs)
      .filter(
        (input): input is { modality: 'audio'; path: string } =>
          typeof input === 'object' &&
          input !== null &&
          (input as { modality?: string }).modality === 'audio',
      )
    expect(audioInputs).toEqual([{ modality: 'audio', path: 'city.wav' }])

    encodeBatch.mockClear()
    const second = await backfillEmbeddings()
    expect(second.audioFiles).toBe(0)
    expect(encodeBatch).not.toHaveBeenCalled()
  }, 30000)

  it('轻量档明确拒绝回填，不发起编码请求', async () => {
    state.enabled = false
    const { backfillEmbeddings } = await import('./backfill')
    await expect(backfillEmbeddings()).rejects.toThrow(/requires MATERIALSEEKER_PROFILE=standard/)
    expect(encodeBatch).not.toHaveBeenCalled()
  })

  it('回填文本与图片描述时并入现有标签，只有标签的图片也能回填', async () => {
    const noteAsset = asset('text', '城市笔记')
    db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(
      JSON.stringify(['城市', '滑板']),
      noteAsset,
    )
    db.prepare('INSERT INTO text_notes (asset_id, content, embedding) VALUES (?, ?, NULL)').run(
      noteAsset,
      '城市建筑',
    )

    const imageAsset = asset('image', '屋顶照片')
    db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(
      JSON.stringify(['夜景']),
      imageAsset,
    )
    db.prepare(
      'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, ?, NULL, NULL)',
    ).run(imageAsset, 'roof.png', '红色屋顶')

    const tagOnlyAsset = asset('image', '只有标签的图片')
    db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(
      JSON.stringify(['纯标签']),
      tagOnlyAsset,
    )
    db.prepare(
      'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, NULL, NULL, NULL)',
    ).run(tagOnlyAsset, 'tag-only.png')

    const videoAsset = asset('video', '视频标签不应改变帧语料')
    db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(
      JSON.stringify(['不应追加']),
      videoAsset,
    )
    db.prepare(
      'INSERT INTO frames (asset_id, timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index) VALUES (?, 0, ?, ?, NULL, NULL, 0)',
    ).run(videoAsset, 'frame.jpg', '城市画面')

    const { backfillEmbeddings } = await import('./backfill')
    const stats = await backfillEmbeddings()
    expect(stats.textNotes).toBe(1)
    expect(stats.imageCaptions).toBe(2)
    expect(stats.frameCaptions).toBe(1)

    const texts = encodeBatch.mock.calls
      .flatMap(([req]) => req.inputs)
      .filter(
        (input): input is { modality: 'text'; text: string } =>
          typeof input === 'object' &&
          input !== null &&
          (input as { modality?: string }).modality === 'text',
      )
      .map((input) => input.text)
    expect(texts).toEqual(
      expect.arrayContaining(['城市建筑 城市 滑板', '红色屋顶 夜景', '纯标签', '城市画面']),
    )
    expect(texts).not.toContain('城市画面 不应追加')
  })
})
