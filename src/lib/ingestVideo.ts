import { getDb, embeddingToBlob } from './db'
import { DEFAULT_COLLECTION_ID } from './collections'
import { PATHS } from './paths'
import { encodeBatch, PASSAGE_INSTRUCTION } from './embed'
import { chunkByScene, chunkFixed, chunkGreedy, type Sentence } from './chunking'
import { clearServiceProgress, pollServiceProgress } from './serviceProgress'

/**
 * 视频入库编排。四个步骤，每步的失败都单独可观测：
 *
 * 1. 调视频处理服务（8281）拿场景边界、帧文件、句级转写
 * 2. 起 transcript + sentences，句级毫秒时间戳直接落库
 * 3. 按策略分块并编码（默认场景对齐，与帧的上下文一致）
 * 4. 帧编码入库（图片向量一路；帧描述文本留待 VLM 接入）
 *
 * 帧描述为空时 frames.caption_embedding 是 NULL，检索路 2 不出力，
 * 这是当前已知的能力缺口，不是 bug。
 *
 * **进度**：整个流程由 ingestRunner 在后台跑，本模块通过 onStage 把阶段报出去。
 * 阶段分两路：视频处理服务那边（prepare/scenes/frames/audio/transcribe）由
 * serviceProgress 轮询得到，编码与写库这几步由本模块直接报。两路都汇总到
 * 同一个 job 行上，前端只认 job 行，不关心进度是哪儿来的。
 */

const VIDEO_SERVICE = process.env.VIDEOSEEKER_VIDEO_URL || 'http://127.0.0.1:8281'

export type IngestStage =
  | 'queued'
  | 'prepare'
  | 'scenes'
  | 'frames'
  | 'audio'
  | 'transcribe'
  | 'text-encode'
  | 'db'
  | 'frame-encode'
  | 'done'

export interface StageSub {
  /** 细粒度进度（抽帧 3/12、帧编码 24/50） */
  done?: number
  total?: number
  /** 转写阶段：音频时长，用于估算等待 */
  durationMs?: number
}

export type StageCallback = (stage: IngestStage, sub?: StageSub) => void

export interface VideoIngestOptions {
  /** 归到哪个素材库，缺省默认库 */
  collectionId?: number
  videoPath: string
  title?: string
  strategy?: 'scene' | 'fixed' | 'greedy'
  sceneThreshold?: number
  minSceneDuration?: number
  maxScenes?: number
  /** 阶段回调。runner 用它把进度写进 job 行 */
  onStage?: StageCallback
}

export interface VideoIngestResult {
  assetId: number
  transcriptId: number
  chunkCount: number
  sentenceCount: number
  frameCount: number
  strategy: string
}

/** 帧编码一批发多少张。图片编码一次前向只能发一类，批太小则往返次数多。 */
const FRAME_ENCODE_BATCH = 8

export async function ingestVideo(opts: VideoIngestOptions): Promise<VideoIngestResult> {
  const db = getDb()
  const {
    collectionId = DEFAULT_COLLECTION_ID,
    videoPath,
    title = videoPath.split(/[\\/]/).pop() || videoPath,
    strategy = 'scene',
    sceneThreshold,
    minSceneDuration,
    maxScenes,
    onStage,
  } = opts

  const stage = (s: IngestStage, sub?: StageSub) => onStage?.(s, sub)

  // 服务端任务号。给视频处理服务用来在它自己那边记进度，Node 侧轮询它。
  const serviceJobId = `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  // --- 1. 视频处理服务 ---
  stage('prepare')
  const processPromise = fetch(`${VIDEO_SERVICE}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_path: videoPath,
      scene_threshold: sceneThreshold,
      min_scene_duration: minSceneDuration,
      max_scenes: maxScenes,
      frames_out_dir: PATHS.framesDir,
      job_id: serviceJobId,
    }),
  })
  const { response: res, stop: stopPoller } = await pollServiceProgress(
    serviceJobId,
    processPromise,
    (p) => stage(p.stage as IngestStage, { done: p.done, total: p.total, durationMs: p.duration_ms }),
  )

  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`视频处理服务 ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      scenes: Array<{ start_ms: number; end_ms: number }>
      frames: Array<{ scene_index: number; timestamp_ms: number; path: string }>
      sentences: Array<{ sentence: string; start_ms: number; end_ms: number; spk_id: string | null }>
    }

    const sentences: Sentence[] = data.sentences.map((s) => ({
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.sentence,
    }))
    const sceneBounds = [0, ...data.scenes.map((s) => s.end_ms)]

    // --- 2. asset + transcript + sentences ---
    const asset = db
      .prepare(
        'INSERT INTO assets (kind, title, source_path, meta_json, collection_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'video',
        title,
        videoPath,
        JSON.stringify({
          scene_count: data.scenes.length,
          sentence_count: sentences.length,
          frame_count: data.frames.length,
        }),
        collectionId,
      )
    const assetId = Number(asset.lastInsertRowid)

    const tr = db
      .prepare(
        'INSERT INTO transcripts (asset_id, full_text, language, asr_engine) VALUES (?, ?, ?, ?)',
      )
      .run(assetId, sentences.map((s) => s.text).join(' '), 'zh', 'funasr-paraformer-zh')
    const transcriptId = Number(tr.lastInsertRowid)

    // --- 3. 分块 + 编码 ---
    stage('text-encode')
    const chunks =
      strategy === 'scene'
        ? chunkByScene(sentences, sceneBounds)
        : strategy === 'fixed'
          ? chunkFixed(sentences)
          : chunkGreedy(sentences)

    let encoded: Float32Array[] = []
    if (chunks.length > 0) {
      encoded = await encodeBatch({
        inputs: chunks.map((c) => ({
          modality: 'text' as const,
          text: c.text,
          instruction: PASSAGE_INSTRUCTION,
        })),
      })
    }

    stage('db')
    const tx = db.transaction(() => {
      const insertTranscriptSentence = db.prepare(
        'INSERT INTO transcript_sentences (transcript_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)',
      )
      for (const s of sentences) {
        insertTranscriptSentence.run(transcriptId, s.start_ms, s.end_ms, s.text)
      }

      const insertChunk = db.prepare(
        `INSERT INTO chunks (transcript_id, chunk_index, start_ms, end_ms, text, chunk_strategy, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      const insertChunkSentence = db.prepare(
        'INSERT INTO sentences (chunk_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)',
      )
      chunks.forEach((c, i) => {
        const r = insertChunk.run(
          transcriptId,
          c.chunk_index,
          c.start_ms,
          c.end_ms,
          c.text,
          c.strategy,
          encoded[i] ? embeddingToBlob(encoded[i]) : null,
        )
        const chunkId = Number(r.lastInsertRowid)
        // 同一个句子在两处各存一份：transcript 级的用于全文展示，chunk 级的用于命中展开。
        // 冗余是故意的，检索路径不该为拿句级时间戳再 join 一次全文表。
        for (const s of c.sentences) {
          insertChunkSentence.run(chunkId, s.start_ms, s.end_ms, s.text)
        }
      })

      const insertFrame = db.prepare(
        `INSERT INTO frames (asset_id, timestamp_ms, thumb_path, caption, embedding, caption_embedding, scene_index)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const f of data.frames) {
        insertFrame.run(assetId, f.timestamp_ms, f.path, null, null, null, f.scene_index)
      }
    })
    tx()

    // --- 4. 帧编码 ---
    // 单独一轮，因为图片编码一次前向只能发一类，混在文本批里会退化成逐张往返。
    // 分批发是为了能报进度：几十张帧一次前向要好几分钟，期间进度条完全不动。
    let frameCount = 0
    if (data.frames.length > 0) {
      stage('frame-encode', { done: 0, total: data.frames.length })
      const vecs: Float32Array[] = new Array(data.frames.length)
      for (let i = 0; i < data.frames.length; i += FRAME_ENCODE_BATCH) {
        const slice = data.frames.slice(i, i + FRAME_ENCODE_BATCH)
        const batchVecs = await encodeBatch({
          inputs: slice.map((f) => ({ modality: 'image' as const, path: f.path })),
        })
        batchVecs.forEach((v, j) => {
          vecs[i + j] = v
        })
        frameCount += slice.length
        stage('frame-encode', { done: frameCount, total: data.frames.length })
      }

      const updateFrame = db.prepare(
        'UPDATE frames SET embedding = ? WHERE asset_id = ? AND scene_index = ?',
      )
      const txF = db.transaction(() => {
        data.frames.forEach((f, i) => {
          updateFrame.run(embeddingToBlob(vecs[i]), assetId, f.scene_index)
        })
      })
      txF()
    }

    stage('done', { done: 1, total: 1 })

    return {
      assetId,
      transcriptId,
      chunkCount: chunks.length,
      sentenceCount: sentences.length,
      frameCount,
      strategy,
    }
  } finally {
    // 无论成败都停轮询并清掉服务端进度条目：失败路径同样会留下 done 条目，
    // 那是常驻内存。
    stopPoller()
    void clearServiceProgress(serviceJobId)
  }
}
