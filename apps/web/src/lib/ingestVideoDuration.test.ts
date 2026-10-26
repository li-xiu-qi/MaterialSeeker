import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'better-sqlite3'

vi.mock('./embed', () => ({
  encodeBatch: vi.fn(),
  embeddingEnabled: () => false,
  PASSAGE_INSTRUCTION: 'passage: ',
}))

vi.mock('./serviceProgress', () => ({
  pollServiceProgress: async (_jobId: string, processPromise: Promise<Response>) => ({
    response: await processPromise,
    stop: vi.fn(),
  }),
  clearServiceProgress: vi.fn(),
}))

let dataDir: string
let db: Database

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'materialseeker-video-duration-'))
  process.env.MATERIALSEEKER_DATA_DIR = dataDir
  process.env.MATERIALSEEKER_PROFILE = 'light'
  vi.resetModules()
  db = (await import('./db')).getDb()
}, 30000)

afterEach(() => {
  db?.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function mockProcessResponse(payload: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

function storedDuration(assetId: number): number | null {
  const row = db.prepare('SELECT duration_ms FROM assets WHERE id = ?').get(assetId) as {
    duration_ms: number | null
  }
  return row.duration_ms
}

const basePayload = {
  scenes: [{ start_ms: 0, end_ms: 297541 }],
  frames: [],
  sentences: [{ sentence: '第一句', start_ms: 0, end_ms: 295540, spk_id: null }],
  asr_provider: 'subtitle',
}

describe('视频真实时长', () => {
  it('入库保存视频流时长，详情接口原样返回', async () => {
    mockProcessResponse({ ...basePayload, duration_ms: 297541 })
    const { ingestVideo } = await import('./ingestVideo')
    const result = await ingestVideo({ videoPath: 'source.mp4' })

    expect(storedDuration(result.assetId)).toBe(
      297541,
    )
    const { getVideoDetail } = await import('./library')
    expect(getVideoDetail(result.assetId)?.asset.durationMs).toBe(297541)
  }, 30000)

  it('旧推理服务未返回时长时保持未知，不拿末句时间冒充', async () => {
    mockProcessResponse(basePayload)
    const { ingestVideo } = await import('./ingestVideo')
    const result = await ingestVideo({ videoPath: 'old-service.mp4' })

    expect(
      storedDuration(result.assetId),
    ).toBeNull()
    const { getVideoDetail } = await import('./library')
    expect(getVideoDetail(result.assetId)?.asset.durationMs).toBeNull()
  }, 30000)
})
