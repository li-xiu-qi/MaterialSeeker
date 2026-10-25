import { describe, expect, it } from 'vitest'
import { likePattern, libraryWhere, MAX_PAGE } from './libraryFilter'

/**
 * 素材库筛选的回归。筛选用的是 `libraryWhere`，它产出 SQL 片段而不是筛后的数组，
 * 所以断言的是**片段与绑定参数的形状**，不是结果集。
 *
 * 这条规则与返回形状相关的约束仍在，但换了住处：原来靠 filterLibraryList 保证
 * 「三个组的键永远都在」，现在由 SQL 侧保证——三条查询各自 WHERE a.kind = ?，
 * 类型筛掉的那两条自然返回空数组，不存在「少了键」这一说。仍然要断言的是片段
 * 拼得对、参数个数与 ? 对得上，那是新的翻车点：**参数多一个少一个不报错，只会
 * 让某一条查询静默用错值。**
 */

describe('likePattern', () => {
  it('纯空白与未定义都返回 null，即不拼关键词条件', () => {
    expect(likePattern(undefined)).toBeNull()
    expect(likePattern('')).toBeNull()
    expect(likePattern('   ')).toBeNull()
  })

  it('包上 %%，两端都能部分匹配', () => {
    expect(likePattern('MV')).toBe('%MV%')
  })

  it('转义 %% _ 与反斜杠，避免用户输入被当通配符', () => {
    // 不转义时「100%」会命中所有标题里带「10」的条目，是匹配凭空变多不是变少
    expect(likePattern('100%')).toBe('%100\\%%')
    expect(likePattern('a_b')).toBe('%a\\_b%')
    expect(likePattern('a\\b')).toBe('%a\\\\b%')
  })

  it('中文不受转义影响', () => {
    expect(likePattern('网球')).toBe('%网球%')
  })
})

describe('libraryWhere', () => {
  it('没有关键词时片段是空串、参数是空数组', () => {
    // 空串而不是空片段由调用方判断要不要拼：三条查询里拼的位置相同，
    // 判断分散到三处迟早有一处漏。
    const r = libraryWhere({})
    expect(r.sql).toBe('')
    expect(r.args).toEqual([])
    expect(r.kw).toBeNull()
  })

  it('片段以 AND 开头，直接接在 WHERE 之后即可', () => {
    const r = libraryWhere({ q: 'MV' })
    expect(r.sql.startsWith('AND ')).toBe(true)
    expect(r.sql).toBe("AND (a.title LIKE ? ESCAPE '\\')")
  })

  it('每个 ? 都有一个绑定值，数量必须对得上', () => {
    // 这条是整个文件最要紧的：better-sqlite3 对不上数量会抛错，但多给一个值
    // 在有些版本是按位置错配，不抛也不报，结果静默变错
    for (const kind of [undefined, 'video', 'image', 'text'] as const) {
      const r = libraryWhere({ kind, q: '网球' })
      const questionMarks = r.sql.match(/\?/g) ?? []
      expect(questionMarks.length, `${kind} 的 ? 个数`).toBe(r.args.length)
    }
  })

  it('图片多匹配一列画面描述，视频与文本只匹配标题', () => {
    // 视频没有整片描述字段（是逐帧的），文本的正文不进 images.caption。
    // 给它们加 caption 只会匹配到 null，白搜一场还让人以为搜索坏了。
    expect(libraryWhere({ kind: 'image', q: '网球' }).sql).toContain('im.caption')
    expect(libraryWhere({ kind: 'video', q: '网球' }).sql).not.toContain('caption')
    expect(libraryWhere({ kind: 'text', q: '网球' }).sql).not.toContain('caption')
    expect(libraryWhere({ q: '网球' }).sql).not.toContain('caption')
  })

  it('ESCAPE 子句与 likePattern 的转义配套，两处必须同时存在', () => {
    // 只有转义没有 ESCAPE 子句的话，反斜杠会被当成普通字符参与匹配，
    // 用户搜「100%」反而一条都匹配不到
    const r = libraryWhere({ q: '100%' })
    expect(r.sql).toContain("ESCAPE '\\'")
    expect(r.args[0]).toBe('%100\\%%')
  })

  it('纯空白关键词等价于没有关键词', () => {
    const r = libraryWhere({ q: '   ', kind: 'image' })
    expect(r.sql).toBe('')
    expect(r.args).toEqual([])
  })

  it('类型不进这个片段', () => {
    // 类型条件由各查询自己写 a.kind = ?，这里只管关键词。
    // 混在一起出的话，页面的空态文案分不出「被类型筛掉」与「没有匹配」。
    for (const kind of ['video', 'image', 'text'] as const) {
      expect(libraryWhere({ kind, q: 'MV' }).sql).not.toContain('kind')
    }
  })
})

describe('MAX_PAGE', () => {
  it('是正整数，且大于一屏的条数', () => {
    // 上限小于一页的话，「显示更多」永远点不动，看着像坏了
    expect(Number.isInteger(MAX_PAGE)).toBe(true)
    expect(MAX_PAGE).toBeGreaterThan(24)
  })
})
