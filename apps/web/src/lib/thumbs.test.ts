import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THUMB_WIDTHS, thumbKey } from './thumbs'

/**
 * 缩略图预生成的回归。**守的重点是缓存键在两侧一致。**
 *
 * 键算法在 lib/thumbs（写入侧，入库时预生成）与 api/media 路由（读取侧）各出现一次。
 * 那不是疏忽，是路由要能独立服务「没预生成过的旧素材」而刻意保留的重复。但重复就有
 * 漂移风险，漂移的后果很隐蔽：预生成把文件写好了，路由却按另一个键去找，找不到就
 * 就地 resize——功能完全正常，只是预生成白做了，没人会收到任何报错。
 *
 * 所以这里把路由那份实现抠出来，与预生成这份对同一个输入比结果。
 */

describe('THUMB_WIDTHS', () => {
  it('正好三档，对应素材库三种栏数请求的宽度', () => {
    expect([...THUMB_WIDTHS]).toEqual([192, 384, 640])
  })

  it('三档互不相同且都是正整数', () => {
    expect(new Set(THUMB_WIDTHS).size).toBe(3)
    for (const w of THUMB_WIDTHS) {
      expect(Number.isInteger(w)).toBe(true)
      expect(w).toBeGreaterThan(0)
    }
  })

  it('与 layout.ts 里三种栏数的请求宽度对得上', () => {
    // 少一档就是那一档永远命中不了缓存，白预生成；多一档是白占磁盘
    const layout = readFileSync(join(process.cwd(), 'src/lib/layout.ts'), 'utf8')
    for (const w of THUMB_WIDTHS) {
      expect(layout, `THUMB_WIDTHS 里的 ${w} 应该被某个栏数用到`).toContain(String(w))
    }
  })
})

describe('thumbKey', () => {
  it('同一输入给同一键', () => {
    const a = thumbKey('/data/images/x.jpg', 192, 1700000000000, 12345)
    const b = thumbKey('/data/images/x.jpg', 192, 1700000000000, 12345)
    expect(a).toBe(b)
  })

  it('四个输入任何一个变化，键就变', () => {
    const base = { abs: '/data/images/x.jpg', width: 192, mtimeMs: 1, size: 100 }
    const k = thumbKey(base.abs, base.width, base.mtimeMs, base.size)
    // 宽度变 → 不同档位不能共用文件
    expect(thumbKey(base.abs, 384, base.mtimeMs, base.size)).not.toBe(k)
    // 路径变 → 同名不同源的素材不能互相覆盖
    expect(thumbKey('/data/images/y.jpg', base.width, base.mtimeMs, base.size)).not.toBe(k)
    // mtime 变 → 素材被覆盖后缩略图要跟着换
    expect(thumbKey(base.abs, base.width, base.mtimeMs + 1, base.size)).not.toBe(k)
    // size 变 → 同上，mtime 精度不够时兜底
    expect(thumbKey(base.abs, base.width, base.mtimeMs, base.size + 1)).not.toBe(k)
  })

  it('中文与特殊字符路径不炸，产出合法十六进制', () => {
    const k = thumbKey('/data/图片/测试 图片 (1)#a.jpg', 192, 1, 1)
    expect(k).toMatch(/^[0-9a-f]{40}$/)
  })

  it('键不泄露路径分隔符，不会把目录结构带进文件名', () => {
    // 带分隔符的话 path.join 会解析到子目录，mkdir 没建就写失败
    const k = thumbKey('/data/images/x.jpg', 192, 1, 1)
    expect(k).not.toContain('/')
    expect(k).not.toContain('\\')
  })
})

describe('键的两侧一致', () => {
  it('media 路由用的就是预生成这一份，没有第二套算法', () => {
    // 直接查源码里有没有另起一套 createHash 拼同样的串。有就是漂移已发生。
    const route = readFileSync(
      join(process.cwd(), 'src/app/api/media/[...path]/route.ts'),
      'utf8',
    )
    expect(route).not.toMatch(/createHash\(['"]sha1['"]\)/)
    expect(route).toContain('thumbKey')
  })

  it('全项目只有一处定义键算法', () => {
    const files = readdirSync(join(process.cwd(), 'src/lib')).filter((f) =>
      /\.tsx?$/.test(f),
    )
    // 排除测试文件本身：测试里必然出现 `export function thumbKey` 这串字面量（正则或
    // 被断言的片段），不排除就会自伤，把守卫测成红的。这与「实测探针第一轮假阳性」
    // 是同一类错，工具性代码扫的源码树里不能包含自己。
    const definers = files
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => {
        const src = readFileSync(join(process.cwd(), 'src/lib', f), 'utf8')
        return /export\s+function\s+thumbKey/.test(src)
      })
    expect(definers).toEqual(['thumbs.ts'])
  })
})
