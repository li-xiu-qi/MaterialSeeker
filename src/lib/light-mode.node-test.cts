import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialseeker-light-'))
process.env.MATERIALSEEKER_PROFILE = 'light'
process.env.MATERIALSEEKER_DATA_DIR = dataDir
// 任何漏掉的向量调用都会尝试访问这个必定不可用的地址，从而让测试失败。
process.env.MATERIALSEEKER_INFERENCE_URL = 'http://127.0.0.1:1'

const { embeddingEnabled } = require('./embed') as typeof import('./embed')
const { ingestText } = require('./ingest') as typeof import('./ingest')
const { getDb } = require('./db') as typeof import('./db')
const { search } = require('./search') as typeof import('./search')

after(() => {
  getDb().close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('轻量模式不走向量服务，文本入库后可用 FTS 检索', async () => {
  assert.equal(embeddingEnabled(), false)
  const assetId = await ingestText(
    '轻量文本',
    '滑板少年在草地上表演，背景有城市建筑',
  )
  const db = getDb()
  const note = db.prepare('SELECT embedding FROM text_notes WHERE asset_id = ?').get(assetId) as {
    embedding: Buffer | null
  }
  const chunks = db.prepare(
    'SELECT c.embedding FROM chunks c JOIN transcripts t ON t.id = c.transcript_id WHERE t.asset_id = ?',
  ).all(assetId) as Array<{ embedding: Buffer | null }>
  assert.equal(note.embedding, null)
  assert.ok(chunks.length > 0)
  assert.ok(chunks.every((c) => c.embedding === null))

  const hits = await search('城市建筑', { modality: 'text' })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].type, 'chunk')
  if (hits[0].type === 'chunk') {
    assert.equal(hits[0].assetId, assetId)
    assert.equal(hits[0].assetKind, 'text')
    assert.equal(hits[0].source, 'keyword')
  }
})

test('轻量模式按图片描述与帧描述做关键词检索', async () => {
  const db = getDb()
  const imageId = Number(db.prepare(
    "INSERT INTO assets (kind, title, collection_id) VALUES ('image', '屋顶照片', 1)",
  ).run().lastInsertRowid)
  db.prepare(
    'INSERT INTO images (asset_id, file_path, caption, embedding, caption_embedding) VALUES (?, ?, ?, NULL, NULL)',
  ).run(imageId, 'unused-image.png', '红色屋顶与白色墙面')

  const videoId = Number(db.prepare(
    "INSERT INTO assets (kind, title, collection_id) VALUES ('video', '城市视频', 1)",
  ).run().lastInsertRowid)
  db.prepare(
    'INSERT INTO frames (asset_id, timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
  ).run(videoId, 1200, 'unused-frame.jpg', '黄昏时的城市天际线', 0)

  const imageHits = await search('红色屋顶', { modality: 'image' })
  assert.equal(imageHits.length, 1)
  assert.equal(imageHits[0].type, 'image')
  assert.equal(imageHits[0].source, 'keyword')

  const frameHits = await search('城市天际线', { modality: 'video' })
  assert.equal(frameHits.length, 1)
  assert.equal(frameHits[0].type, 'frame')
  assert.equal(frameHits[0].source, 'keyword')
})

test('标准档开关保留，非法档位会明确报错', () => {
  process.env.MATERIALSEEKER_PROFILE = 'standard'
  assert.equal(embeddingEnabled(), true)
  process.env.MATERIALSEEKER_PROFILE = 'invalid'
  assert.throws(() => embeddingEnabled(), /unknown MATERIALSEEKER_PROFILE/)
  process.env.MATERIALSEEKER_PROFILE = 'light'
})
