import { describe, expect, it } from 'vitest'
import { RECENT_LIMIT } from './recent'

/**
 * 「最近入库」条数的守卫测试。
 *
 * 这个数字被改过四次，所以测试守的不是某个巧合值，是**不许变成浏览入口**这件事：
 *
 * 1. 12 条铺 6 列 2 行刚好一屏，落地页高度等于视口高，往下滚滚轮纹丝不动，
 *    用户以为页面坏了。
 * 2. 24 条起步可翻到 96 条。用户原话：「我们只是放最近的五个就行了，你直接放了
 *    几百个不限制就太离谱了。」矫枉过正，首页成了第二个素材库。
 * 3. 定在 5 条，铺满 5 列一行。
 * 4. 第 4 次改成 10 条，并把 grid 换成横向滚动。变的理由是 5 列 grid 每张卡
 *    约 300x80（宽高比 3.75:1），object-cover 把 16:9 的横图上下裁掉近一半，
 *    用户报过「图片怎么有部分被裁剪了」。横滚后不要求铺满一行，卡片能按接近
 *    原图的形状给，10 条排一行横向滚，垂直占用与 5 条时持平。
 *
 * 所以「≤5」这种针对 grid 列数的断言在这里已经不成立，换成守上限与形态。
 */

describe('RECENT_LIMIT', () => {
  it('是个小整数，不为 0 也不带小数', () => {
    // 0 会让整块不渲染，落地页的引导就没了；小数传给 SQL 的 LIMIT 行为不定
    expect(Number.isInteger(RECENT_LIMIT)).toBe(true)
    expect(RECENT_LIMIT).toBeGreaterThan(0)
  })

  it('不超过 10，够首屏可见加一点余量', () => {
    // 横向滚动时容器首屏只完整露出六七张。放到 10 是「眼前这些加一点余量」，
    // 再往上堆的是看不见的内容，而那正是第 2 次改错的方向。
    expect(RECENT_LIMIT).toBeLessThanOrEqual(10)
  })

  it('不许回到「刚好一屏所以滚不动」的那个量级', () => {
    // 12 条 6 列 2 行 = 页面高度正好等于视口高，这个区间整体是禁区
    expect(RECENT_LIMIT).toBeLessThan(12)
  })

  it('至少 5 条，别缩回看不见库里有什么的程度', () => {
    // 这一排是落地页唯一的「库里有什么」线索。太少了新手进来只看到一两个
    // 方块，仍然不知道这库是干什么的
    expect(RECENT_LIMIT).toBeGreaterThanOrEqual(5)
  })

  it('模块只导出这一个常量，防止有人把分页加回来', async () => {
    // 这一条是对矫枉过正那次改动的直接封堵：API 一旦还在，下一个人很容易
    // 顺着「支持翻页」的思路又把它做成浏览入口。用模块导出清单判断，比
    // grep 可靠（grep 会把注释里的字样一起算上）。
    const mod = (await import('./recent')) as Record<string, unknown>
    const exported = Object.keys(mod).filter((k) => k !== 'default')
    expect(exported).toEqual(['RECENT_LIMIT'])
    expect(mod).not.toHaveProperty('clampRecentShown')
    expect(mod).not.toHaveProperty('hasMoreRecent')
    expect(mod).not.toHaveProperty('RECENT_PAGE')
    expect(mod).not.toHaveProperty('RECENT_MAX')
  })
})
