import { NextResponse } from 'next/server'
import { analyzeBatch } from '@/lib/analyze'

export const runtime = 'nodejs'
// 批量标注是分钟级：十张图每张秒级，但排队与网络抖动叠起来会到分钟。
// 默认 60 秒不够，给到 300。
//
// 2026-09-26 起每张被限流时会退避重试，最多约 30 秒。二十张里若有十张撞上容量
// 窗口，最坏能到十分钟以上，所以放到 900。这是自建 next start，没有平台侧的
// 函数时长上限，长连接期间前端一直在收进度，不是干等。
export const maxDuration = 900

/**
 * POST /api/library/analyze/batch  body: { ids: number[] }
 *
 * 批量 AI 标注。**逐个跑，一个失败不影响其他**，全部跑完才返回汇总。
 *
 * 为什么不并发：视觉模型按调用计费，一次发十张过去既可能被限流，失败也不好定位到
 * 具体哪一张。逐个来的另一个好处是前端能拿到真实进度——十张图要一两分钟，期间界面
 * 完全不动比慢本身更让人以为坏了。
 *
 * 进度通过 SSE 风格的单行 JSON 推送，不是轮询：这条路本来就是长连接，多开一个轮询
 * 接口只为了显示进度不值得。
 */
export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const ids = (body as { ids?: unknown }).ids
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: '需要 ids 数组' }, { status: 400 })
  }
  const clean = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0)
  if (clean.length === 0) {
    return NextResponse.json({ error: '没有合法 id' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(o)}\n`))
        } catch {
          // 客户端已经断开：剩下的标注没有意义，直接收工
        }
      }

      try {
        const { ok, failed } = await analyzeBatch(clean, (done, total, current, note) => {
          // note 只在退避等待时才有值，透传即可：缺字段时 JSON.stringify 会整个
          // 省掉这个键，解析端拿到的就是 undefined，正好是「不显示」的意思。
          send({ type: 'progress', done, total, current, note })
        })
        send({ type: 'done', ok: ok.length, failed })
      } catch (e) {
        send({ type: 'fatal', error: e instanceof Error ? e.message : String(e) })
      } finally {
        try {
          controller.close()
        } catch {
          /* 已经关了 */
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
