import { describe, expect, it } from 'vitest'
import { COL_OPTIONS, parseCols, LIST_CLS, THUMB_W, COVER_W } from './layout'

/**
 * 栏数布局的回归。**这个文件针对的是一个只在生产里现形的缺陷类别。**
 *
 * 双栏与四栏曾经整块不生效，控制台一声不响：Tailwind 按源码里出现过的字面类名
 * 生成 CSS，`grid-cols-${cols}` 拼出来的类名构建时不存在，扫不到就不生成。
 * 这种缺陷在单栏状态下完全看不出来（那几个类根本用不到），所以必须靠断言守。
 */

describe('parseCols', () => {
  it('认得出 2 与 4', () => {
    expect(parseCols('2')).toBe(2)
    expect(parseCols('4')).toBe(4)
  })

  it('其余一切回落单栏，包括 1 本身', () => {
    expect(parseCols('1')).toBe(1)
    expect(parseCols(undefined)).toBe(1)
    expect(parseCols('')).toBe(1)
  })

  it('不支持的档位回落而不是抛错', () => {
    // 参数用户可以手打。抛错会让整页 500，回落单栏至少看得见东西。
    expect(parseCols('3')).toBe(1)
    expect(parseCols('0')).toBe(1)
    expect(parseCols('-4')).toBe(1)
    expect(parseCols('abc')).toBe(1)
    expect(parseCols('12')).toBe(1)
  })
})

describe('COL_OPTIONS', () => {
  it('正好三档，且 value 与 parseCols 认得的对得上', () => {
    expect(COL_OPTIONS.map((o) => o.value)).toEqual(['1', '2', '4'])
    for (const o of COL_OPTIONS) {
      expect(parseCols(o.value)).toBe(Number(o.value))
    }
  })

  it('每个档位都有中文标签', () => {
    for (const o of COL_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0)
      expect(o.label).toMatch(/[\u4e00-\u9fa5]/)
    }
  })
})

describe('LIST_CLS', () => {
  it('三个档位全有值', () => {
    // 少一个档位就是那个档位的列表整块没有容器类
    expect(LIST_CLS[1]).toBeTruthy()
    expect(LIST_CLS[2]).toBeTruthy()
    expect(LIST_CLS[4]).toBeTruthy()
  })

  it('三个档位的类互不相同', () => {
    // 两个档位给同一份类 = 其中一档的切换看着生效实际没变
    expect(new Set(Object.values(LIST_CLS)).size).toBe(3)
  })

  it('多栏必须真的是 grid，单栏必须是竖排间距', () => {
    // 单栏用 space-y（卡片竖着排），多栏用 grid（卡片按列排）。两者不能混，
    // 混了的形态是「切到四栏还是一列」或者「单栏变成一列挤在左边」。
    expect(LIST_CLS[1]).toContain('space-y-3')
    expect(LIST_CLS[1]).not.toContain('grid')
    expect(LIST_CLS[2]).toContain('grid-cols-2')
    expect(LIST_CLS[4]).toContain('grid-cols-4')
  })

  it('类名是字面量，不含模板拼接', () => {
    /*
      这条断言曾经写成 expect(cls).not.toContain('${')，注入探针证明它是恒过的
      装饰品：模板字符串一旦求值，${\} 就从值里消失了，LIST_CLS[2] 运行时仍是
      正常的 'mt-3 grid grid-cols-2 gap-3'。也就是说这类 bug 在运行时完全看不出来，
      只有源码扫描能抓到——那件事由 guards.test.ts 的「不许拿变量拼栅格类名」负责，
      它扫的是文本不是求值结果。

      这里退一步守能守的：让类名里确实带着 grid-cols-N 这个字面量片段。挡不住
      拼接，但挡得住有人把多栏的类整块删成空串或写成别的写法。
    */
    expect(LIST_CLS[2]).toContain('grid-cols-2')
    expect(LIST_CLS[4]).toContain('grid-cols-4')
  })
})

describe('THUMB_W 与 COVER_W', () => {
  it('三个档位全有值且为正', () => {
    for (const table of [THUMB_W, COVER_W]) {
      for (const cols of [1, 2, 4] as const) {
        expect(table[cols]).toBeGreaterThan(0)
      }
    }
  })

  it('多栏请求的图比单栏大，否则会被拉糊', () => {
    // 二栏卡片内容宽约 409px，仍按单栏的 192px 请求会被放大 2.2 倍，肉眼可见地糊
    expect(THUMB_W[2]).toBeGreaterThan(THUMB_W[1])
    expect(COVER_W[2]).toBeGreaterThan(COVER_W[1])
  })

  it('四栏不比二栏小，那一档卡片窄但数量多', () => {
    expect(THUMB_W[4]).toBeGreaterThanOrEqual(THUMB_W[1])
    expect(COVER_W[4]).toBeGreaterThanOrEqual(COVER_W[1])
  })
})
