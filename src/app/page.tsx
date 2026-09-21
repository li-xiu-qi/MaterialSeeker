/**
 * 首页，M1-M3 冒烟界面：一个检索栏 + 混合结果流 + 上传面板。
 * 交互设计见 product-design 仓 01_PRD/产品需求文档.md 第四节。
 */
import { search } from '@/lib/search'
import type { SearchHit } from '@/lib/search'
import { UploadPanel } from '@/components/UploadPanel'

export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; m?: string }>
}) {
  const { q, m } = await searchParams
  let hits: SearchHit[] = []
  let error: string | null = null

  if (q && q.trim()) {
    try {
      hits = await search(q.trim(), { modality: (m as 'all') || 'all' })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">VideoSeeker</h1>
      <p className="mt-1 text-sm text-neutral-400">
        多模态内容检索工作台（冒烟界面）
      </p>

      <form action="/" method="get" className="mt-6 flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="搜什么"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
        >
          检索
        </button>
      </form>

      <UploadPanel />

      {error && (
        <p className="mt-4 rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          推理服务不可用：{error}
        </p>
      )}

      {q && !error && (
        <p className="mt-6 text-sm text-neutral-400">
          {hits.length === 0 ? '没有命中' : `命中 ${hits.length} 条`}
        </p>
      )}

      <ul className="mt-4 space-y-3">
        {hits.map((h) => (
          <li
            key={`${h.type}:${h.id}:${h.source}`}
            className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4"
          >
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5">{h.type}</span>
              <span>{h.source}</span>
              <span className="ml-auto tabular-nums">{h.score.toFixed(3)}</span>
            </div>
            {h.type === 'chunk' && (
              <>
                <p className="mt-2 text-sm text-neutral-300">{h.chunkText}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  {h.assetTitle} · {fmtMs(h.startMs)} - {fmtMs(h.endMs)} ·{' '}
                  {h.sentences.length} 句
                </p>
              </>
            )}
            {h.type === 'frame' && (
              <p className="mt-2 text-sm text-neutral-300">
                {h.assetTitle} · {fmtMs(h.timestampMs)} · {h.caption ?? '（无描述）'}
              </p>
            )}
            {h.type === 'image' && (
              <p className="mt-2 text-sm text-neutral-300">
                {h.assetTitle} · {h.caption ?? '（无描述）'}
              </p>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}

function fmtMs(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
