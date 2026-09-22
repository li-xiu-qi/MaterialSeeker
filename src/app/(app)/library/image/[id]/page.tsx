import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getImageDetail } from '@/lib/library'
import { fmtScore } from '@/lib/format'

export const dynamic = 'force-dynamic'

/**
 * 图片素材详情。**服务端直出**：这一页和前面那个右侧抽屉是同一份内容，
 * 但抽屉要等客户端 JS，JS 一旦不生效就整块看不见。既然详情页是只读的，
 * 就没有理由让它依赖 hydration，所以做成真实页面，URL 也能收藏和分享。
 *
 * 相似邻居在这里是真实链接，点一张跳到另一张，链条靠 URL 而不是前端状态。
 * 检索回路也在：带着 caption 跳检索页。
 */

export default async function ImageDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const num = Number(id)
  if (!Number.isInteger(num) || num <= 0) notFound()

  const detail = getImageDetail(num)
  if (!detail) notFound()

  const { asset, url, neighbours } = detail

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/library" className="text-xs text-neutral-500 underline hover:text-neutral-300">
        返回素材库
      </Link>

      <h1 className="mt-3 text-2xl font-semibold">{asset.title}</h1>
      <p className="mt-1 text-[11px] text-neutral-600">入库于 {asset.createdAt}</p>

      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={asset.caption ?? ''}
              className="w-full rounded-md border border-neutral-800"
            />
          ) : (
            <div className="flex h-40 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-600">
              原图不在库内，无法预览
            </div>
          )}

          <p className="mt-4 text-sm leading-6 text-neutral-300">
            {asset.caption ?? '（这张图还没有画面描述，只能按画面内容命中）'}
          </p>

          {asset.caption && (
            <Link
              href={`/?q=${encodeURIComponent(asset.caption)}`}
              className="mt-4 inline-block rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
            >
              以此为查询词再检索
            </Link>
          )}
        </div>

        <aside className="space-y-4">
          <dl className="space-y-1 text-[11px] text-neutral-600">
            <div className="flex justify-between gap-3">
              <dt>画面特征</dt>
              <dd className="text-neutral-500">{asset.hasVector ? '就绪' : '缺失'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>描述特征</dt>
              <dd className="text-neutral-500">{asset.hasCaptionVector ? '就绪' : '缺失'}</dd>
            </div>
          </dl>

          <section>
            <h2 className="text-xs font-medium text-neutral-400">相似素材（{neighbours.length}）</h2>
            {neighbours.length === 0 ? (
              <p className="mt-2 text-[11px] text-neutral-700">
                这张图没有可用的画面特征，算不出相似素材。
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {neighbours.map((n) => (
                  <li key={n.id}>
                    <Link
                      href={`/library/image/${n.id}`}
                      className="flex items-center gap-3 rounded-md border border-neutral-800 p-2 hover:border-neutral-600"
                    >
                      {n.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={n.url}
                          alt=""
                          loading="lazy"
                          className="h-14 w-20 flex-none rounded border border-neutral-800 object-cover"
                        />
                      ) : (
                        <div className="h-14 w-20 flex-none rounded border border-neutral-800 bg-neutral-900" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-neutral-300">{n.title}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-neutral-600">
                          {n.caption ?? '（无描述）'}
                        </span>
                      </span>
                      <span className="flex-none text-[11px] tabular-nums text-neutral-500">
                        {fmtScore(n.score)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
