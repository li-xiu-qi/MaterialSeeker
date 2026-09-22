/**
 * 首页：统一检索栏 + 混合结果流 + 入库面板。
 * 交互设计见 product-design 仓 01_PRD/产品需求文档.md 第四节。
 *
 * 本文件是服务端组件，负责把检索结果加工成客户端组件可直接渲染的
 * view model（重点是算好媒体 URL：路径计算要用 node:path，客户端做不了）。
 */
import { search } from '@/lib/search'
import Link from 'next/link'
import { toMediaUrl, toThumbUrl } from '@/lib/media'
import { fmtMs } from '@/lib/format'
import { UploadPanel } from '@/components/UploadPanel'
import { ResultList, type ResultItem } from '@/components/ResultList'

export const dynamic = 'force-dynamic'

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; m?: string }>
}) {
  const { q, m } = await searchParams
  let items: ResultItem[] = []
  let error: string | null = null

  if (q && q.trim()) {
    try {
      const hits = await search(q.trim(), { modality: (m as 'all') || 'all' })
      items = hits.map((h): ResultItem => {
        if (h.type === 'chunk') {
          return {
            key: `${h.type}:${h.id}:${h.source}`,
            type: h.type,
            source: h.source,
            score: h.score,
            text: h.chunkText,
            title: h.assetTitle,
            meta: `${h.assetTitle} · ${fmtMs(h.startMs)} - ${fmtMs(h.endMs)}`,
            mediaUrl: null,
            coverUrl: toThumbUrl(h.coverFrame, 320),
            isVideo: Boolean(h.assetPath),
            chunk: {
              chunkText: h.chunkText,
              startMs: h.startMs,
              endMs: h.endMs,
              sentences: h.sentences,
              videoUrl: toMediaUrl(h.assetPath),
            },
          }
        }

        if (h.type === 'frame') {
          return {
            key: `${h.type}:${h.id}:${h.source}`,
            type: h.type,
            source: h.source,
            score: h.score,
            text: h.caption ?? '',
            title: h.assetTitle,
            meta: `${h.assetTitle} · ${fmtMs(h.timestampMs)}`,
            mediaUrl: toThumbUrl(h.thumbPath, 320),
            fullUrl: toMediaUrl(h.thumbPath),
            coverUrl: null,
            isVideo: true,
            chunk: null,
          }
        }

        return {
          key: `${h.type}:${h.id}:${h.source}`,
          type: h.type,
          source: h.source,
          score: h.score,
          text: h.caption ?? '',
          title: h.assetTitle,
          meta: h.assetTitle,
          mediaUrl: toThumbUrl(h.filePath, 320),
          fullUrl: toMediaUrl(h.filePath),
          coverUrl: null,
          isVideo: false,
          chunk: null,
        }
      })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">VideoSeeker</h1>
      <div className="mt-1 flex items-baseline gap-3">
        <p className="text-sm text-neutral-400">多模态内容检索工作台</p>
        <Link href="/library" className="text-xs text-neutral-500 underline hover:text-neutral-300">
          素材库
        </Link>
      </div>

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

      {q && !error && <ResultList items={items} />}
    </main>
  )
}
