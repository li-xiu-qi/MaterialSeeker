import { getDb, embeddingToBlob } from './db'
import { DEFAULT_COLLECTION_ID } from './collections'
import { encodeAudio, encodeBatch, embeddingEnabled, PASSAGE_INSTRUCTION } from './embed'
import { chunkGreedy, type Sentence } from './chunking'
import { clearServiceProgress, pollServiceProgress } from './serviceProgress'
import { asrEngineLabel } from './asrEngine'

/**
 * 音频入库编排。**视频入库去掉「帧」那一半**，其余完全同构：
 *
 * 1. 调转写服务（8281 的 /transcribe）拿句级转写
 * 2. 编码音频文件本身的向量（标准档）
 * 3. 起 asset + audio_files + transcript + transcript_sentences
 * 4. 分块并编码转写文本（默认 greedy，音频没有场景边界可用）
 * 5. chunks + sentences 落库
 *
 * **为什么单独一个文件而不是给 ingestVideo 加个 if**：视频那条路上挂着帧的
 * 抽取、编码、缩略图预热三步，音频一步都没有。加 if 会让这条链路里出现三处
 * 「音频不走这里」的判断，而其中帧预热那处还是 void 掉的异步，看代码时容易
 * 以为音频也会预热。分开写，两边各自读起来都是完整的流程。
 *
 * **音频复用 transcripts / chunks / sentences 三张表，不新建**：它们的结构本来
 * 就是「一段媒体 + 时间轴 + 分块」，与模态无关。音频没有 frames 是因为没有
 * 画面内容，不是需要另一套转写表。两张转写表各存一份的代价会是「改分块策略
 * 要改两处」，而音频与视频的分块策略本来就该收敛在同一份代码里。
 */

const VIDEO_SERVICE = process.env.MATERIALSEEKER_VIDEO_URL || 'http://127.0.0.1:8281'

export type AudioIngestStage =
  | 'queued'
  | 'prepare'
  | 'transcribe'
  | 'audio-encode'
  | 'text-encode'
  | 'db'
  | 'done'

export interface AudioStageSub {
  /** 转写阶段：音频时长，用于估算等待 */
  durationMs?: number
}

export type AudioStageCallback = (stage: AudioIngestStage, sub?: AudioStageSub) => void

export interface AudioIngestOptions {
  collectionId?: number
  audioPath: string
  title?: string
  hotword?: string
  /** 阶段回调。runner 用它把进度写进 job 行 */
  onStage?: AudioStageCallback
}

export interface AudioIngestResult {
  assetId: number
  transcriptId: number
  chunkCount: number
  sentenceCount: number
  durationMs: number
}

export async function ingestAudio(opts: AudioIngestOptions): Promise<AudioIngestResult> {
  const db = getDb()
  const useEmbedding = embeddingEnabled()
  const {
    collectionId = DEFAULT_COLLECTION_ID,
    audioPath,
    title = audioPath.split(/[\\/]/).pop() || audioPath,
    hotword,
    onStage,
  } = opts

  const stage = (s: AudioIngestStage, sub?: AudioStageSub) => onStage?.(s, sub)
  const serviceJobId = `vs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  // --- 1. 转写服务 ---
  stage('prepare')
  const processPromise = fetch(`${VIDEO_SERVICE}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_path: audioPath, hotword: hotword ?? '', job_id: serviceJobId }),
  })
  const { response: res, stop: stopPoller } = await pollServiceProgress(
    serviceJobId,
    processPromise,
    (p) => stage(p.stage as AudioIngestStage, { durationMs: p.duration_ms }),
  )

  try {
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`转写服务 ${res.status}: ${body.slice(0, 300)}`)
    }
    const data = (await res.json()) as {
      sentences: Array<{ sentence: string; start_ms: number; end_ms: number }>
      // 实际生效的 ASR 路径，云端回退本地时报 local（旧版本无此字段）
      asr_provider?: string
    }

    const sentences: Sentence[] = data.sentences.map((s) => ({
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.sentence,
    }))

    // --- 2. 音频文件本身的向量（标准档）---
    // 放在任何数据库写入之前：推理失败就不留半个音频素材，用户重试时不会
    // 看到「库里多了一条没有向量的音频」。轻量档跳过，audio_files.embedding
    // 保持 NULL，之后可用回填接口补。
    let audioVector: Float32Array | null = null
    if (useEmbedding) {
      stage('audio-encode')
      ;[audioVector] = await encodeAudio(audioPath)
    }

    // --- 3. asset + audio_files + transcript + sentences ---
    const fullText = sentences.map((s) => s.text).join(' ')
    // 时长取最后一句的结尾，而不是 ffprobe 单独问一次：句级时间戳是转写服务
    // 已经算出来的，再探测一次文件是白等一轮 IO，且当转写为空句时两者都会是 0，
    // 没有信息差。
    const durationMs = sentences.length > 0 ? sentences[sentences.length - 1].end_ms : 0

    const asset = db
      .prepare(
        'INSERT INTO assets (kind, title, source_path, meta_json, collection_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'audio',
        title,
        audioPath,
        JSON.stringify({ sentence_count: sentences.length }),
        collectionId,
        durationMs,
      )
    const assetId = Number(asset.lastInsertRowid)

    db.prepare(
      'INSERT INTO audio_files (asset_id, file_path, duration_ms, embedding) VALUES (?, ?, ?, ?)',
    ).run(assetId, audioPath, durationMs, audioVector ? embeddingToBlob(audioVector) : null)

    const tr = db
      .prepare('INSERT INTO transcripts (asset_id, full_text, language, asr_engine) VALUES (?, ?, ?, ?)')
      .run(assetId, fullText, 'zh', asrEngineLabel(data.asr_provider))
    const transcriptId = Number(tr.lastInsertRowid)

    // --- 4. 分块 + 编码 ---
    // greedy 而不是 scene：音频没有画面，场景边界无从算起；固定窗口会把一句话
    // 从中间切断，命中后定位到半句比不命中更糟。
    if (useEmbedding) stage('text-encode')
    const chunks = chunkGreedy(sentences)
    let encoded: Float32Array[] = []
    if (chunks.length > 0 && useEmbedding) {
      encoded = await encodeBatch({
        inputs: chunks.map((c) => ({
          modality: 'text' as const,
          text: c.text,
          instruction: PASSAGE_INSTRUCTION,
        })),
      })
    }

    // --- 5. 落库 ---
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
        for (const s of c.sentences) {
          insertChunkSentence.run(chunkId, s.start_ms, s.end_ms, s.text)
        }
      })
    })
    tx()

    stage('done')
    return {
      assetId,
      transcriptId,
      chunkCount: chunks.length,
      sentenceCount: sentences.length,
      durationMs,
    }
  } finally {
    stopPoller()
    void clearServiceProgress(serviceJobId)
  }
}
