import Link from 'next/link'
import { UploadPanel } from '@/components/UploadPanel'
import { listCollections, normalizeCollectionId, getCollection } from '@/lib/collections'

export const dynamic = 'force-dynamic'

/**
 * 入库页。**独立页面，不再挤在检索页里。**
 *
 * 拆出来的理由：入库与检索是两种不同节奏的事。检索是「想想搜什么」然后看结果，
 * 入库是「选一批文件然后等它处理完」，视频入库要几分钟。混在一页时，入库面板
 * 常驻占着首屏，检索结果反而被推到下面；而且视频处理期间页面一直是处理态，
 * 想顺手搜点什么就得等。分成两页各管一件事。
 *
 * 目标库从 URL 的 lib 参数来。上传走原生表单提交到 /api/ingest/form，
 * 服务端入库后重定向回本页并带上 ok/name/id/detail 或 err，所以**整条入库
 * 链路不依赖客户端 JS**：选文件、提交、看结果都不需要 hydration。JS 只是让
 * 「选完文件即提交」省掉一次点击，并给拖放与多文件用的。
 */
export default async function IngestPage({
  searchParams,
}: {
  searchParams: Promise<{
    lib?: string
    ok?: string
    name?: string
    id?: string
    detail?: string
    err?: string
  }>
}) {
  const { lib, ok, name, id, detail, err } = await searchParams
  const collections = listCollections()
  const currentId = normalizeCollectionId(lib)
  const current = getCollection(currentId)

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">入库</h1>
      <p className="mt-1 text-sm text-neutral-400">
        当前入库到「{current ? current.name : '默认库'}」，切换库请在上方选择
      </p>

      {err && (
        <p className="mt-4 rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          入库失败：{err}
        </p>
      )}
      {ok && (
        <div className="mt-4 rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          <p>
            {ok === 'image' ? '图片' : '视频'}「{name}」已入库（#{id}）
            {detail ? ` · ${detail}` : ''}
          </p>
          <Link href={`/?lib=${currentId}`} className="mt-1 inline-block text-[11px] underline">
            去检索这个库
          </Link>
        </div>
      )}

      <UploadPanel
        collections={collections.map((c) => ({ id: c.id, name: c.name }))}
        currentCollectionId={currentId}
      />
    </div>
  )
}
