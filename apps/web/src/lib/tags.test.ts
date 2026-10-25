import { describe, expect, it } from 'vitest'
import { parseTags, serializeTags, composeCaptionText, MAX_TAGS, MAX_TAG_LEN } from './tags'

/**
 * 标签的规则。**这里是纯函数，不碰 db**，所以断言能一条条写死。
 *
 * 这些用例多数对应一次真实的读库事故：库里默认值是 '[]'，早先把「解析出空数组」
 * 当成「解析失败」，于是回退去切 '[]' 这两个字符，详情页的标签框里就多出一个
 * 字面量 `[]` 标签，而保存时它还会被写回库。所以 parseTags('[]') 必须是空数组，
 * 这一条是全文件最重要的断言。
 */
describe('parseTags', () => {
  it('空 JSON 数组是空列表，不是字面量标签', () => {
    // 库里绝大多数行的默认值，读错就是给每个素材加一个 `[]` 标签
    expect(parseTags('[]')).toEqual([])
    expect(parseTags('  []  ')).toEqual([])
    })

  it('非空 JSON 数组正常解析', () => {
    expect(parseTags('["猫","夜景"]')).toEqual(['猫', '夜景'])
    })

  it('中英文逗号分号都能切', () => {
    expect(parseTags('猫,夜景')).toEqual(['猫', '夜景'])
    expect(parseTags('猫，夜景')).toEqual(['猫', '夜景'])
    expect(parseTags('访谈;开场白')).toEqual(['访谈', '开场白'])
    expect(parseTags('访谈；开场白')).toEqual(['访谈', '开场白'])
    })

  it('数组入参一个元素就是一个标签，不再按逗号切', () => {
    // 数组路径不做逗号切分：那是字符串路径的事（AI 标注给的是串）。数组里
    // 含逗号意味着调用方自己没分好，按整串当一个标签，比替他猜怎么切更可预期。
    expect(parseTags([' a , , b '])).toEqual(['a , , b'])
    expect(parseTags(['猫', '夜景'])).toEqual(['猫', '夜景'])
    })

  it('字符串入参才按逗号切，且空段被丢掉', () => {
    expect(parseTags('猫, 夜景,, 访谈,')).toEqual(['猫', '夜景', '访谈'])
  })

  it('空串与空数组都是空', () => {
    expect(parseTags('')).toEqual([])
    expect(parseTags('   ')).toEqual([])
    expect(parseTags([])).toEqual([])
    })

  it('非字符串非数组一律当空', () => {
    expect(parseTags(null)).toEqual([])
    expect(parseTags(undefined)).toEqual([])
    expect(parseTags(42)).toEqual([])
    expect(parseTags({ a: 1 })).toEqual([])
    })

  it('坏的 JSON 回头看纯字符串，不抛错', () => {
    // 以 [ 开头但不是合法 JSON：按文本切，而不是让调用方崩
    expect(parseTags('[官方MV],Rick')).toEqual(['[官方MV]', 'Rick'])
    })

  it('大小写不敏感去重', () => {
    // 不重的话两个标签只差一个字母，看着像 bug，还各占一个名额
    expect(parseTags(['MV', 'mv', 'Mv'])).toEqual(['MV'])
    })

  it('压掉内部连续空白并裁剪首尾', () => {
    expect(parseTags(['  猫   咪  '])).toEqual(['猫 咪'])
    })

  it('超过条数上限后截断', () => {
    const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `标签${i}`)
    expect(parseTags(many)).toHaveLength(MAX_TAGS)
  })

  it('单条超长时按字符上限裁', () => {
    const long = 'x'.repeat(MAX_TAG_LEN + 30)
    expect(parseTags([long])[0]).toHaveLength(MAX_TAG_LEN)
  })

  it('序列化后能原样读回', () => {
    const tags = ['猫', '夜景', '访谈']
    expect(parseTags(serializeTags(tags))).toEqual(tags)
    expect(parseTags(serializeTags([]))).toEqual([])
    })
})

describe('composeCaptionText', () => {
  it('标签拼在描述后面，用空格分隔', () => {
    expect(composeCaptionText('一只猫在窗台', ['夜景'])).toBe('一只猫在窗台 夜景')
  })

  it('描述为空时只剩标签', () => {
    expect(composeCaptionText(null, ['夜景', '访谈'])).toBe('夜景 访谈')
    expect(composeCaptionText('', ['夜景'])).toBe('夜景')
  })

  it('描述与标签都空时是空串', () => {
    // 空串意味着不编码那一路向量，检索侧按 IS NOT NULL 筛，别编出一个空语料的向量
    expect(composeCaptionText(null, [])).toBe('')
    expect(composeCaptionText('   ', [])).toBe('')
  })

  it('标签自身带的空格不影响拼接', () => {
    expect(composeCaptionText('图', [' 猫 '])).toBe('图 猫')
  })
})
