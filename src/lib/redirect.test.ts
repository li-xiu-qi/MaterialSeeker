import { describe, expect, it } from 'vitest'
import { redirectBack, safeBack } from './redirect'

/**
 * 回跳的回归测试。**这个文件守住的是一个连续修错三次的坑。**
 *
 * 三次的形态分别是：用假 base 拼参数（Location 发出去是不存在的 host）、
 * 把相对路径交给框架的 redirect 助手（它只要绝对 URL，接口 500）、
 * 用请求的 origin 当 base（服务端拿到的永远是 localhost，与请求来源无关）。
 *
 * 所以断言不只测「跳对了没有」，直接钉死 Location 头的**形式**：
 * 它必须是相对路径。只要实现里再出现 `new URL(back, 'http://...')` 这种假
 * base，或者把 URL 对象交给 NextResponse.redirect，下面第一条就会红。
 */

describe('safeBack', () => {
  it('接受站内相对路径', () => {
    expect(safeBack('/library')).toBe('/library')
    expect(safeBack('/library?lib=1&k=image')).toBe('/library?lib=1&k=image')
  })

  it('挡掉协议相对URL，那是开放重定向', () => {
    // //evil.com 在浏览器眼里是「用当前协议访问 evil.com」
    expect(safeBack('//evil.com')).toBe('/')
    expect(safeBack('///evil.com')).toBe('/')
  })

  it('挡掉绝对地址与非 / 开头', () => {
    expect(safeBack('https://evil.com')).toBe('/')
    expect(safeBack('library')).toBe('/')
    expect(safeBack('')).toBe('/')
    expect(safeBack(null)).toBe('/')
    expect(safeBack(undefined)).toBe('/')
  })
})

describe('redirectBack', () => {
  it('发的是相对 Location，不含任何 host', async () => {
    const res = redirectBack('/library', { made: 31 })
    const location = res.headers.get('location')

    expect(location).toBe('/library?made=31')
    // 这三条是三次修错的共同死因，逐个钉死
    expect(location).not.toContain('http://')
    expect(location).not.toContain('https://')
    expect(location).not.toMatch(/^\/\//)
  })

  it('状态码 303，表单 POST 后用 GET 重新取回跳页', () => {
    expect(redirectBack('/library').status).toBe(303)
  })

  it('响应体为空，只靠 Location 头与状态码', async () => {
    const res = redirectBack('/library')
    expect(await res.text()).toBe('')
  })

  it('参数按 URLSearchParams 规则转义，不手工拼字符串', () => {
    // 中文与特殊字符必须被编码。手拼字符串的版本会让 「&」 与 「#」 把参数截断。
    const res = redirectBack('/library', { kw: '网球 运动员', cerr: 'a&b=c#d' })
    const location = res.headers.get('location') ?? ''
    const u = new URL(location, 'http://placeholder.invalid')

    expect(u.searchParams.get('kw')).toBe('网球 运动员')
    expect(u.searchParams.get('cerr')).toBe('a&b=c#d')
  })

  it('undefined / null / 空串不占位', () => {
    // 空串占位会让 URL 上多一个 `made=`，页面据此判断「刚刚建了库」就会误触发
    const res = redirectBack('/library', { made: '', deleted: undefined, moved: null, k: 'image' })
    expect(res.headers.get('location')).toBe('/library?k=image')
  })

  it('重复键后者覆盖前者，不出现两份', () => {
    const res = redirectBack('/library', { k: 'all' })
    expect(res.headers.get('location')).toBe('/library?k=all')
  })

  it('保留 back 自带的查询参数，并与之合并', () => {
    const res = redirectBack('/library?lib=1&k=all', { select: 1 })
    expect(res.headers.get('location')).toBe('/library?lib=1&k=all&select=1')
  })

  it('back 非法时回落首页，参数照样带上', () => {
    // safeBack 的回落不能让 params 丢：回落页常常要靠参数显示结果提示
    expect(redirectBack('//evil.com', { made: 7 }).headers.get('location')).toBe('/?made=7')
  })

  it('back 里的 #fragment 不会把参数挤丢', () => {
    // URL 对象只取 pathname 与 search，fragment 被有意丢掉：303 之后浏览器
    // 用 GET 重新取页面，带 fragment 会跳到不存在的锚点。
    const res = redirectBack('/library?a=1#x', { k: 'image' })
    expect(res.headers.get('location')).toBe('/library?a=1&k=image')
  })

  it('数字参数被转成字符串，不会变成 [object Object]', () => {
    expect(redirectBack('/library', { made: 0 }).headers.get('location')).toBe('/library?made=0')
  })
})
