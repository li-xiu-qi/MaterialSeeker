import { describe, expect, it } from 'vitest'
import {
  FINISHED_TTL_SECONDS,
  finishedWindowArg,
  finishedWindowSql,
} from './queueWindow'

/**
 * 终态任务可见时间窗的回归。**守的是四种「写错了但不报错」的失效。**
 *
 * 这个项目的很多缺陷属于这一类：SQL 拼错一个修饰符、时间比较交给 JS 解析，
 * 结果不是抛错而是功能静默消失。用户看到的症状是「任务不消失」或「任务凭空没了」，
 * 两者都很难往 SQL 上想。所以这几条断言比看上去重要。
 */

describe('finishedWindowSql', () => {
  it('以 AND 开头，直接拼在已有 WHERE 之后', () => {
    expect(finishedWindowSql().startsWith('AND ')).toBe(true)
  })

  it('带上一个 ? 占位符，且只有一个', () => {
    const marks = finishedWindowSql().match(/\?/g) ?? []
    expect(marks.length).toBe(1)
  })

  it('挡住 finished_at 为 NULL 的行', () => {
    // NULL 参与比较得 NULL，那一行会被永久滤掉。用户看到的是「任务凭空消失」，
    // 比挂着更难排查，所以必须先显式挡掉。
    expect(finishedWindowSql()).toContain('finished_at IS NOT NULL')
  })

  it("带 modifier 形式的时间参数，不是裸秒数", () => {
    // SQLite 只认 datetime('now','localtime', '-120 seconds') 这种形式。
    // 写成 datetime('now','localtime', 120) 会 silently 忽略，窗口变永远可见。
    expect(finishedWindowSql()).toContain("datetime('now','localtime', ?)")
  })
})

describe('finishedWindowArg', () => {
  it('产出 SQLite 认的 modifier 串', () => {
    expect(finishedWindowArg(120)).toBe('-120 seconds')
  })

  it('秒数至少钳到 1，永不产出 0 或负数窗口', () => {
    // -0 seconds 等于「刚刚之前」，把终态任务全滤掉，队列永远只剩进行中的；
    // 负数则是给未来留窗口，老任务反而更显眼。
    expect(finishedWindowArg(0)).toBe('-1 seconds')
    expect(finishedWindowArg(-5)).toBe('-1 seconds')
  })

  it('小数被截断成整数', () => {
    // SQLite 的 modifier 解析不接受小数秒
    expect(finishedWindowArg(120.9)).toBe('-120 seconds')
  })

  it('默认值与导出的常数一致，改一个不会只改一半', () => {
    expect(finishedWindowArg()).toBe(`-${FINISHED_TTL_SECONDS} seconds`)
  })
})

describe('FINISHED_TTL_SECONDS', () => {
  it('长 enough 让人看见成功反馈', () => {
    // 视频入库等了好几分钟，进度条一归零那一行就没了，人反而要跑去素材库翻，
    // 不确定刚才那一下到底进没进库
    expect(FINISHED_TTL_SECONDS).toBeGreaterThanOrEqual(30)
  })

  it('短 enough 不变常驻噪音', () => {
    // 队列是「现在有什么事」的告示。挂几分钟的已完成条目会让下一次上传时
    // 用户分不清哪条是新的
    expect(FINISHED_TTL_SECONDS).toBeLessThanOrEqual(300)
  })

  it('是整数', () => {
    expect(Number.isInteger(FINISHED_TTL_SECONDS)).toBe(true)
  })
})
