import {
  createJob,
  getJob,
  markInterruptedJobs,
  pruneJobs,
  updateJob,
  type JobRow,
} from './jobs'
import { ingestVideo, type IngestStage, type StageSub } from './ingestVideo'
import { ingestAudio, type AudioIngestStage, type AudioStageSub } from './ingestAudio'
import { ingestImage } from './ingest'

/**
 * 入库任务队列。视频入库是分钟级，不能再让浏览器干等一个 HTTP 响应：
 * 提交时建一条 job 行并立刻返回 jobId，由这里在后台逐个执行，前端轮询 job 行
 * 拿阶段与百分比。
 *
 * **为什么串行不并发**：两件重活都吃同一份 GPU 资源（embedding 服务只有一个
 * 进程），两个视频同时跑不会快一倍，只会让两个都变慢、还把显存顶满。排队
 * 反而让每个任务的耗时更可预测，反正进度条是按任务逐个显示的。
 *
 * **进程模型**：队列活在 Next 的 Node 进程里，没有独立 worker。代价是重启
 * 会丢掉在飞的执行者，所以启动时把 queued/running 一律标成中断（见 jobs.ts）。
 * 这是个单机单人工具，不值得为它再拆一个常驻进程。
 */

const stage: Record<IngestStage, { label: string; at: number }> = {
  // at 是该阶段结束时进度条应到的位置。顺序即用户看到的顺序。
  queued: { label: '排队中', at: 0 },
  prepare: { label: '检查与准备', at: 5 },
  scenes: { label: '分析画面切换', at: 25 },
  frames: { label: '抽取关键帧', at: 45 },
  audio: { label: '抽取音轨', at: 55 },
  transcribe: { label: '语音转文字', at: 62 },
  'text-encode': { label: '文字向量化', at: 85 },
  db: { label: '写入库', at: 92 },
  'frame-encode': { label: '画面向量化', at: 95 },
  done: { label: '完成', at: 100 },
}

const STAGE_ORDER: IngestStage[] = [
  'queued',
  'prepare',
  'scenes',
  'frames',
  'audio',
  'transcribe',
  'text-encode',
  'db',
  'frame-encode',
  'done',
]

/**
 * 音频的阶段序。**不与视频共用 STAGE_ORDER。**
 *
 * 音频没有 scenes/frames/frame-encode 三步，共用的话 transcribe 在视频那条序里
 * 排第 6，音频从 prepare（5%）直接跳到 transcribe（62%），中间的检查与抽音轨
 * 被显示成「已完成一大半」，而那时音频还没开始转。音频这条序里 transcribe 是
 * 第二步，占比给足——它是音频入库全程最长的一段。
 */
const AUDIO_STAGE_ORDER: AudioIngestStage[] = [
  'queued',
  'prepare',
  'transcribe',
  'text-encode',
  'db',
  'done',
]

/** 音频的阶段权重。与视频同一套 stage 表的 label，权重另给。 */
const AUDIO_STAGE_AT: Record<AudioIngestStage, number> = {
  queued: 0,
  prepare: 5,
  transcribe: 70,
  'text-encode': 90,
  db: 96,
  done: 100,
}

export function audioStageToPercent(s: AudioIngestStage, sub?: AudioStageSub): number {
  const idx = AUDIO_STAGE_ORDER.indexOf(s)
  if (idx < 0) return 0
  const base = AUDIO_STAGE_AT[s]
  const next = AUDIO_STAGE_ORDER[idx + 1]
  if (!next || s === 'done') return base
  const span = AUDIO_STAGE_AT[next] - base
  // 转写阶段没有 done/total 可插值（FunASR 一次 generate 跑完才返回），
  // 所以给 0  fractional，进度条停在 transcribe 起点直到它真的结束。
  return Math.round(base)
}

/**
 * 把阶段与细分数折算成百分比。
 *
 * 用阶段权重而不是按时间比例估：时间根本估不准（不知道视频多长、有没有音轨），
 * 猜出来的数字一旦和现实脱节，用户会以为进度条是假的。阶段权重至少有依据，
 * 卡在某一格就是真的卡在那一步。
 */
export function stageToPercent(s: IngestStage, sub?: StageSub): number {
  const idx = STAGE_ORDER.indexOf(s)
  if (idx < 0) return 0
  const base = stage[s].at
  const next = STAGE_ORDER[idx + 1]
  if (!next || s === 'done') return base

  // 阶段内有细分数（抽帧 3/12）就在本阶段区间内插值；没有则给区间中点，
  // 让进度条进入新阶段时是「走了一小步」而不是「原地不动」。
  const span = stage[next].at - base
  const frac = sub && sub.total && sub.total > 0
    ? Math.max(0, Math.min(1, (sub.done ?? 0) / sub.total))
    : 0
  return Math.round(base + span * frac)
}

export function stageLabel(s: string): string {
  return stage[s as IngestStage]?.label ?? s
}

/** 队列里还没开始的任务 id。 */
const queue: number[] = []
let running = false
let booted = false

/** 进程启动时跑一次：收拾上次留下的残局。 */
export function bootRunner(): void {
  if (booted) return
  booted = true
  const interrupted = markInterruptedJobs()
  pruneJobs()
  if (interrupted > 0) {
    console.warn(`[ingest] ${interrupted} 个未完成任务被标记为中断（服务重启）`)
  }
}

function enqueue(ids: number[]): void {
  queue.push(...ids)
  void pump()
}

/**
 * 把上传阶段建好的那些行推进队列。**复用已有 id，不新建行。**
 *
 * 上传前已经由 /api/ingest/prepare 建好了行（状态 uploading），上传完成后
 * 由这里转成 queued 并交给后台执行。若此时行已不在 uploading 状态（被标成
 * 中断、或重复提交），跳过它：重复入队会让同一个文件处理两遍。
 */
export function promoteUploadedJobs(ids: number[]): void {
  bootRunner()
  const ready = ids.filter((id) => {
    const j = getJob(id)
    return j && j.status === 'uploading'
  })
  for (const id of ready) {
    updateJob(id, { status: 'queued', stage: '排队中', message: '排队中' })
  }
  enqueue(ready)
}

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length > 0) {
      const id = queue.shift()!
      const job = getJob(id)
      // 任务可能已被置为取消（目前没有取消入口，但别假设以后不加）
      if (!job || job.status !== 'queued') continue
      await runOne(job)
    }
  } finally {
    running = false
  }
}

async function runOne(job: JobRow): Promise<void> {
  updateJob(job.id, {
    status: 'running',
    stage: 'prepare',
    message: '开始处理',
    started: true,
  })

  const onStage = (s: IngestStage, sub?: StageSub) => {
    const pct = stageToPercent(s, sub)
    const detail =
      s === 'transcribe' && sub?.durationMs
        ? `语音转文字（音频 ${fmtMs(sub.durationMs)}）`
        : s === 'frames' || s === 'frame-encode'
          ? `${stageLabel(s)} ${sub?.done ?? 0}/${sub?.total ?? 0}`
          : stageLabel(s)
    updateJob(job.id, { stage: s, percent: pct, message: detail })
  }

  // 音频的阶段回调与百分比各一套，理由见 AUDIO_STAGE_ORDER 上方。
  const onAudioStage = (s: AudioIngestStage, sub?: AudioStageSub) => {
    const pct = audioStageToPercent(s, sub)
    const detail =
      s === 'transcribe' && sub?.durationMs
        ? `语音转文字（音频 ${fmtMs(sub.durationMs)}）`
        : stageLabel(s)
    updateJob(job.id, { stage: s, percent: pct, message: detail })
  }

  try {
    if (job.kind === 'video') {
      const result = await ingestVideo({
        videoPath: job.file_path ?? '',
        title: job.title,
        collectionId: job.collection_id,
        onStage,
      })
      updateJob(job.id, {
        status: 'done',
        stage: 'done',
        percent: 100,
        message: `${result.frameCount} 帧 · ${result.sentenceCount} 句 · ${result.chunkCount} 块`,
        resultJson: JSON.stringify(result),
        finished: true,
      })
    } else if (job.kind === 'audio') {
      const result = await ingestAudio({
        audioPath: job.file_path ?? '',
        title: job.title,
        collectionId: job.collection_id,
        onStage: onAudioStage,
      })
      updateJob(job.id, {
        status: 'done',
        stage: 'done',
        percent: 100,
        // 音频没有帧，说「帧」会让人以为漏了东西。报句数与块数就够判断
        // 「这段音频是真转写出东西了，还是空跑一遍」。
        message: `${result.sentenceCount} 句 · ${result.chunkCount} 块`,
        resultJson: JSON.stringify(result),
        finished: true,
      })
    } else {
      onStage('db')
      const assetId = await ingestImage(job.title, job.file_path ?? '', undefined, job.collection_id)
      updateJob(job.id, {
        status: 'done',
        stage: 'done',
        percent: 100,
        message: '已入库，可被检索',
        resultJson: JSON.stringify({ assetId }),
        finished: true,
      })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateJob(job.id, {
      status: 'error',
      stage: 'done',
      message: '处理失败',
      error: msg.slice(0, 500),
      finished: true,
    })
    // 失败不阻断队列：后面排队的文件照样要入
  }
}

function fmtMs(ms: number): string {
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

/** 提交一批任务进队列，返回新建的 job id。 */
export function submitJobs(
  jobs: Array<{
    batchId: string
    kind: 'video' | 'image' | 'audio'
    title: string
    filePath?: string
    collectionId: number
  }>,
): number[] {
  // **必须在 createJob 之前启动队列。** 反过来会把刚提交的这一批也当成
  // 「上次进程留下的残局」标成中断：实测表现是任务提交即失败，报的是
  // 「服务重启」，而服务根本没重启过。
  bootRunner()
  const ids = jobs.map((j) => createJob(j))
  enqueue(ids)
  return ids
}
