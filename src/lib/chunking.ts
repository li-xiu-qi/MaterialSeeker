/**
 * 分块策略。三种可配置，默认分配已定案（PRD 开放问题 4，v0.11）：
 *
 * 1. scene：视频默认。与帧的场景边界对齐，逐字稿块与帧的上下文一致。
 *    过小的相邻场景会合并到 MIN_SCENE_CHUNK_CHARS，避免画面切换频率远高于
 *    语义单元导致的碎块（实测不合并时平均只有 94 字）。
 * 2. fixed：固定秒数切分带重叠窗口，没有默认使用者。scene 需要场景信息而
 *    场景检测失败时由 scene 内部回落 greedy，不落到 fixed；fixed 保留给
 *    「明确想要固定时间窗」的调用方显式传参。
 * 3. greedy：音频与纯文本导入的默认。音频没有画面，场景边界无从算起；2000
 *    字符预算比 fixed 的 60 秒窗口更接近语义完整单元（中文语音 60 秒只有
 *    200-300 字）。
 *
 * 三种并存是因为没有全场景最优解。默认值由来源类型决定，调用方一般不传。
 */

export type ChunkStrategy = 'scene' | 'fixed' | 'greedy'

/**
 * scene 策略的块长下限（字符）。低于此值的相邻场景组合并。
 *
 * 300 的来处：中文语速约每秒 4-5 字，300 字约一分钟语音，是一段完整论述的
 * 量级；同时远低于 greedy 的 2000 预算，不会把 scene 变成 greedy。实测 Spark
 * 真实库 scene chunk 平均 94 字，是这个数触发合并的直接原因。
 */
const MIN_SCENE_CHUNK_CHARS = 300

export interface Sentence {
  start_ms: number
  end_ms: number
  text: string
}

export interface Chunk {
  chunk_index: number
  start_ms: number
  end_ms: number
  text: string
  /** 该块包含的句子（含毫秒时间戳，用于命中后句级跳转） */
  sentences: Sentence[]
  strategy: ChunkStrategy
}

/** greedy：按句子贪心拼到字符预算为止 */
export function chunkGreedy(sentences: Sentence[], charBudget = 2000): Chunk[] {
  const chunks: Chunk[] = []
  let current: Sentence[] = []
  let currentLen = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push({
      chunk_index: chunks.length,
      start_ms: current[0].start_ms,
      end_ms: current[current.length - 1].end_ms,
      text: current.map((s) => s.text).join(' '),
      sentences: current,
      strategy: 'greedy',
    })
    current = []
    currentLen = 0
  }

  for (const s of sentences) {
    if (currentLen + s.text.length > charBudget && current.length > 0) flush()
    current.push(s)
    currentLen += s.text.length
  }
  flush()
  return chunks
}

/** fixed：固定窗口切分，相邻窗口重叠 overlapMs，边界落在句子边界上 */
export function chunkFixed(
  sentences: Sentence[],
  windowMs = 60000,
  overlapMs = 10000,
): Chunk[] {
  if (sentences.length === 0) return []
  const chunks: Chunk[] = []
  const start = sentences[0].start_ms
  const end = sentences[sentences.length - 1].end_ms

  let winStart = start
  while (winStart < end) {
    const winEnd = winStart + windowMs
    // 允许越过 overlap 边界取句，保证重叠窗口里至少各有一句
    const members = sentences.filter((s) => s.end_ms > winStart && s.start_ms < winEnd + overlapMs)
    if (members.length > 0) {
      chunks.push({
        chunk_index: chunks.length,
        start_ms: members[0].start_ms,
        end_ms: members[members.length - 1].end_ms,
        text: members.map((s) => s.text).join(' '),
        sentences: members,
        strategy: 'fixed',
      })
    }
    if (winEnd >= end) break
    winStart = winEnd - overlapMs
  }
  return chunks
}

/**
 * scene：按场景边界切分，sceneBounds 是毫秒时间点（含 0 与结尾）。
 *
 * **过小的相邻场景会合并。** 场景边界来自画面切换，而画面切换频率远高于语义
 * 单元：一个 5 秒场景往往只有二十来字。实测 Spark 真实库 23 个 scene chunk
 * 平均 94 字、最大 368 字，这个量级的文本做 embedding 语义不完整，检索噪声
 * 大。所以低于 MIN_SCENE_CHUNK_CHARS 的场景组向前并组，直到达到下限或碰到
 * 一个自身已经不小于下限的组为止（后者是硬边界，不再向前吞并）。
 *
 * 合并的代价是命中后的时间定位变粗（一个 chunk 覆盖多个场景），收益是块内
 * 语义完整。两者不对等：块太碎直接削弱向量质量，定位粗几秒只影响点击后的
 * 观感。
 *
 * sceneBounds 少于 2 个（无场景信息）时回落 greedy。
 */
export function chunkByScene(sentences: Sentence[], sceneBounds: number[]): Chunk[] {
  if (sentences.length === 0) return []
  if (sceneBounds.length < 2) return chunkGreedy(sentences)

  const bounds = [...sceneBounds].sort((a, b) => a - b)

  // 先按场景边界分组（与原实现一致，含最后一个边界之后的残句）
  const groups: Sentence[][] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]
    const hi = bounds[i + 1]
    const members = sentences.filter((s) => s.start_ms >= lo && s.start_ms < hi)
    if (members.length === 0) continue
    groups.push(members)
  }
  const tail = sentences.filter((s) => s.start_ms >= bounds[bounds.length - 1])
  if (tail.length > 0) groups.push(tail)

  // 再把过小的组向前并。倒着扫会漏并（小组后面的大组不该被吞），所以正着扫：
  // 手上这个组太小时，继续吃下一组；吃到不小于下限就收口成块。
  const chunks: Chunk[] = []
  let pending: Sentence[] = []
  for (const g of groups) {
    pending = pending.concat(g)
    const len = pending.map((s) => s.text).join(' ').length
    if (len >= MIN_SCENE_CHUNK_CHARS) {
      chunks.push(toChunk(chunks.length, pending, 'scene'))
      pending = []
    }
  }
  // 收尾：剩下的（整个视频都不足下限，或最后一组太小）单独成块
  if (pending.length > 0) {
    chunks.push(toChunk(chunks.length, pending, 'scene'))
  }
  return chunks
}

/** 句子列表 → chunk。chunk_index 由调用方按产出顺序给。 */
function toChunk(index: number, sentences: Sentence[], strategy: ChunkStrategy): Chunk {
  return {
    chunk_index: index,
    start_ms: sentences[0].start_ms,
    end_ms: sentences[sentences.length - 1].end_ms,
    text: sentences.map((s) => s.text).join(' '),
    sentences,
    strategy,
  }
}
