import { NextResponse } from 'next/server'

/**
 * 带参数回跳到站内相对路径。所有原生表单路由的跳转都走这里。
 *
 * ## 这里踩过两次坑，根因值得记牢
 *
 * **第一次**：框架的 redirect 助手在 Route Handler 里不接受相对路径，传
 * `/library?x=1` 会抛 `URL is malformed` 并让接口 500。所以它要的是绝对 URL。
 * 原先每个路由自己拿一个随手写的假域名当 base 去拼参数，再把 URL 对象交给
 * 助手——Location 头就真的发了那个不存在的域名，浏览器被送去一个连不上的
 * 地址。创建本身其实成功了（库里已有新库），只是回跳那一步炸掉，所以从界面
 * 上看像「没反应」。这个错误模式在 8 个路由里被复制了 22 处。
 *
 * **第二次**：改成用「真实请求的 origin」当 base。看起来对了，实测却发现**不管
 * 从哪个地址访问，服务端拼出来的永远是回环地址上那个固定端口**。原因是
 * `req.url` 在这个运行时段里不含真实 host，它的 origin 是框架给的固定值。
 * 用户从局域网 IP 访问，点创建后被送去回环地址，浏览器报连接被拒绝。
 *
 * 这里连具体地址都不写出来是刻意的：守卫测试会扫源码里的假 base 与假域名
 * 字面量，注释里留一个样例会让它误判，把一条本来干净的守则变成恒红。
 *
 * ## 正解：发相对的 Location
 *
 * HTTP 允许 Location 是相对引用（RFC 7231 §7.1.2），浏览器按当前页面的地址
 * 解析。这样服务端根本不需要知道自己在哪个 host 上，端口转发、反代、换域名、
 * 换 IP 全都自动正确。唯一要绕开的是 Next 的 redirect helper（它拒绝相对路径），
 * 所以这里手动构造响应、自己设 Location 头。
 */

/** next 参数只接受站内相对路径，挡住把它当开放重定向用。 */
export function safeBack(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

/**
 * @param back 要回的相对路径（已过 safeBack）
 * @param params 要挂上去的查询参数，值为 undefined / null / 空串的会被忽略
 * @param status 默认 303：表单 POST 之后要用 GET 重新取回跳页
 */
export function redirectBack(
  back: string,
  params: Record<string, string | number | undefined | null> = {},
  status = 303,
): NextResponse {
  // base 只是个占位，为的是用 URL 对象把 query 拼正确（转义、去重、排序）。
  // 取出来的只有 pathname 与 search，占位 base 不会出现在结果里。
  const url = new URL(safeBack(back), 'http://placeholder.invalid')
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  return new NextResponse(null, {
    status,
    headers: { Location: `${url.pathname}${url.search}` },
  })
}
