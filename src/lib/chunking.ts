/**
 * 分块策略。三种可配置，按来源选默认值：
 *
 * 1. scene：与帧的场景边界对齐，逐字稿块与帧的上下文一致
 * 2. fixed：固定秒数切分带重叠窗口，适合没有明显场景结构的口播
 * 3. greedy：贪心字符兜底，适合纯文本导入
 *
 * 三种并存是因为没有全场景最优解。默认分配规则见 PRD 开放问题 4，
 * 定案前调用方显式传 strategy。
 */

export type ChunkStrategy = 'scene' | 'fixed' | 'greedy'

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

/** scene：按场景边界切分，sceneBounds 是毫秒时间点（含 0 与结尾） */
export function chunkByScene(sentences: Sentence[], sceneBounds: number[]): Chunk[] {
  if (sentences.length === 0) return []
  if (sceneBounds.length < 2) return chunkGreedy(sentences)

  const bounds = [...sceneBounds].sort((a, b) => a - b)
  const chunks: Chunk[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]
    const hi = bounds[i + 1]
    const members = sentences.filter((s) => s.start_ms >= lo && s.start_ms < hi)
    if (members.length === 0) continue
    chunks.push({
      chunk_index: chunks.length,
      start_ms: members[0].start_ms,
      end_ms: members[members.length - 1].end_ms,
      text: members.map((s) => s.text).join(' '),
      sentences: members,
      strategy: 'scene',
    })
  }
  // 最后一个边界之后可能还有残句
  const tail = sentences.filter((s) => s.start_ms >= bounds[bounds.length - 1])
  if (tail.length > 0) {
    chunks.push({
      chunk_index: chunks.length,
      start_ms: tail[0].start_ms,
      end_ms: tail[tail.length - 1].end_ms,
      text: tail.map((s) => s.text).join(' '),
      sentences: tail,
      strategy: 'scene',
    })
  }
  return chunks
}
