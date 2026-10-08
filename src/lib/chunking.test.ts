import { describe, expect, it } from 'vitest'
import { chunkByScene, chunkFixed, chunkGreedy, type Sentence } from './chunking'

/**
 * 分块策略的行为约束。**这里是纯函数，不碰 db**，断言能一条条写死。
 *
 * 这些用例多数对应一次真实的读库发现：Spark 真实库 23 个 scene chunk 平均只有
 * 94 字（一个 5 秒场景二十来字），这个量级做 embedding 语义不完整。所以 scene
 * 的「小块合并」与「不跨过大块」两条规则都有用例钉住，合并阈值改动会先在这里响。
 */

/** 造一句：start/end 按 1 秒一句排，文本用可区分长度的重复串 */
function sent(i: number, text?: string): Sentence {
  return { start_ms: i * 1000, end_ms: (i + 1) * 1000, text: text ?? `第${i}句` }
}

/** 造一段达到目标字数的句子集合 */
function sentsOfChars(total: number, startIdx = 0): Sentence[] {
  const out: Sentence[] = []
  let acc = 0
  let i = startIdx
  while (acc < total) {
    const t = `第${i}句`.padEnd(12, '啊')
    out.push(sent(i, t))
    acc += t.length
    i++
  }
  return out
}

describe('chunkGreedy', () => {
  it('空输入返回空', () => {
    expect(chunkGreedy([])).toEqual([])
  })

  it('按字符预算切块，不切断句子', () => {
    // 每句 14 字符，预算 30：两句一块（28），不把第三句切一半进来
    const sents = [sent(0, '一二三四五六七八九十甲乙'), sent(1, '一二三四五六七八九十甲乙'), sent(2, '一二三四五六七八九十甲乙')]
    const chunks = chunkGreedy(sents, 30)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].sentences).toHaveLength(2)
    expect(chunks[1].sentences).toHaveLength(1)
    expect(chunks[0].strategy).toBe('greedy')
  })

  it('单句超预算时单独成块（不无限膨胀）', () => {
    const long = sent(0, '啊'.repeat(500))
    const chunks = chunkGreedy([long, sent(1, '短句')], 100)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].sentences[0].text).toHaveLength(500)
  })

  it('chunk_index 从 0 连续递增', () => {
    const chunks = chunkGreedy(sentsOfChars(200), 50)
    expect(chunks.map((c) => c.chunk_index)).toEqual(chunks.map((_, i) => i))
  })
})

describe('chunkFixed', () => {
  it('空输入返回空', () => {
    expect(chunkFixed([])).toEqual([])
  })

  it('窗口内的句子进同一块，时间戳取首尾', () => {
    // 窗口 10s、重叠 0：0-10s 两句一块，10-20s 两句一块
    const sents = [sent(0), sent(1), sent(10), sent(11)]
    const chunks = chunkFixed(sents, 10000, 0)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].start_ms).toBe(0)
    expect(chunks[0].end_ms).toBe(2000)
    expect(chunks[1].start_ms).toBe(10000)
  })

  it('重叠窗口让边界句进两个块（不断上下文）', () => {
    // 第 5 句（5000-6000ms）跨第一窗末与第二窗首，应同时落在两个块里
    const sents = [sent(0), sent(5), sent(10), sent(15)]
    const chunks = chunkFixed(sents, 10000, 5000)
    const hit = (t: string) => chunks.filter((c) => c.sentences.some((s) => s.text === t)).length
    expect(hit('第5句')).toBe(2)
    expect(hit('第0句')).toBe(1)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('窗口越界时收敛，不死循环', () => {
    const sents = [sent(0)]
    const chunks = chunkFixed(sents, 60000, 10000)
    expect(chunks).toHaveLength(1)
  })
})

describe('chunkByScene', () => {
  it('空输入返回空', () => {
    expect(chunkByScene([], [0, 1000])).toEqual([])
  })

  it('场景边界少于 2 个时回落 greedy', () => {
    const sents = sentsOfChars(100)
    const chunks = chunkByScene(sents, [0])
    expect(chunks.every((c) => c.strategy === 'greedy')).toBe(true)
  })

  it('过小的相邻场景会合并到下限之上', () => {
    // 三个场景各 20 字，边界 [0,1000,2000,3000]
    const sents = [
      sent(0, '啊'.repeat(20)),
      sent(1, '啊'.repeat(20)),
      sent(2, '啊'.repeat(20)),
    ]
    const chunks = chunkByScene(sents, [0, 1000, 2000, 3000])
    // 单组 20 字 < 300，三组并成一块 60 字仍 < 300，收尾单独成块
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text.length).toBeGreaterThanOrEqual(60)
    expect(chunks[0].strategy).toBe('scene')
  })

  it('已达到下限的场景组是硬边界，不被前一组吞并', () => {
    // 第一组 400 字（自身已 >= 300），第二组 20 字
    const sents = [
      sent(0, '甲'.repeat(400)),
      sent(1, '啊'.repeat(20)),
    ]
    const chunks = chunkByScene(sents, [0, 1000, 2000])
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text.length).toBeGreaterThanOrEqual(300)
    expect(chunks[1].text.length).toBe(20)
  })

  it('合并后 chunk_index 仍从 0 连续', () => {
    const sents = sentsOfChars(900)
    const bounds = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]
    const chunks = chunkByScene(sents, bounds)
    expect(chunks.map((c) => c.chunk_index)).toEqual(chunks.map((_, i) => i))
  })

  it('句子不重复归属（每个句子只进一个 chunk）', () => {
    const sents = sentsOfChars(1000)
    const bounds = [0, 1000, 2000, 3000, 4000, 5000]
    const chunks = chunkByScene(sents, bounds)
    const total = chunks.reduce((n, c) => n + c.sentences.length, 0)
    expect(total).toBe(sents.length)
  })

  it('chunk 的时间戳与所含句子一致（首句开头、末句结尾）', () => {
    const sents = [sent(0, '啊'.repeat(400)), sent(1, '啊'.repeat(20))]
    const chunks = chunkByScene(sents, [0, 1000, 2000])
    expect(chunks[0].start_ms).toBe(0)
    expect(chunks[0].end_ms).toBe(1000)
  })
})
