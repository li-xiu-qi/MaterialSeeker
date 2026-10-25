import { describe, expect, it } from 'vitest'
import { MAX_RESULT_SHOWN, RESULT_PAGE, resultParams } from './searchPaging'

describe('RESULT_PAGE', () => {
  it('是正整数', () => {
    expect(Number.isInteger(RESULT_PAGE)).toBe(true)
    expect(RESULT_PAGE).toBeGreaterThan(0)
  })

  it('小于搜索结果的上限，否则翻页按钮永远不出现', () => {
    // 一页就吃掉全部上限时，「显示更多」是不可达分支，用户看到的结果
    // 永远只有第一页且没有任何提示
    expect(RESULT_PAGE).toBeLessThan(MAX_RESULT_SHOWN)
  })
})

describe('resultParams', () => {
  it('带上查询词与类型，翻页后不丢', () => {
    const p = resultParams('网球', 'video', '3')
    expect(p.get('q')).toBe('网球')
    expect(p.get('m')).toBe('video')
    expect(p.get('lib')).toBe('3')
  })

  it('全部态不带 m，链接保持干净', () => {
    const p = resultParams('网球', 'all', '1')
    expect(p.has('m')).toBe(false)
  })

  it('空查询不带 q，链接指向落地页而不是空结果页', () => {
    const p = resultParams('', 'all', '1')
    expect(p.has('q')).toBe(false)
  })

  it('不往 s 里塞值，翻页条数由调用方另加', () => {
    // 塞了的话第二次翻页会带上上一次的 s，再被调用方覆盖前的瞬间是脏 URL
    const p = resultParams('网球', 'all', '1')
    expect(p.has('s')).toBe(false)
  })

  it('查询词含特殊字符时被正确编码', () => {
    // 不编码的话空格会把 URL 截断，翻页后只剩第一个词
    const p = resultParams('网球场 上的 运动员', 'all', '1')
    expect(p.get('q')).toBe('网球场 上的 运动员')
    // 断言 toString 而不是只断言 get：get 能过只说明值存对了，toString 才决定
    // 拼进 href 之后浏览器拿不拿得到这个词
    expect(p.toString()).toContain('%E8%BF%90%E5%8A%A8%E5%91%98')
    // 空格必须编码成 + 或 %20，不能裸留在 URL 里
    expect(p.toString()).not.toMatch(/q=[^&]* /)
  })
})
