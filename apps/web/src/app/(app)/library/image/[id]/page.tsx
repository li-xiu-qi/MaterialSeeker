import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getImageDetail } from '@/lib/library'
import { fmtScore } from '@/lib/format'
import { embeddingEnabled } from '@/lib/embed'

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
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ edited?: string; cerr?: string }>
}) {
  const { id } = await params
  const { edited, cerr } = await searchParams
  const num = Number(id)
  if (!Number.isInteger(num) || num <= 0) notFound()

  const detail = getImageDetail(num)
  if (!detail) notFound()

  const { asset, url, neighbours } = detail
  const lightMode = !embeddingEnabled()

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/library" className="text-xs text-neutral-400 underline hover:text-neutral-300">
        返回素材库
      </Link>

      <h1 className="mt-3 text-2xl font-semibold">{asset.title}</h1>
      <p className="mt-1 text-xs text-neutral-400">入库于 {asset.createdAt}</p>

      {cerr && <p className="mt-3 text-xs text-red-400">{cerr}</p>}
      {edited && (
        <p className="mt-3 text-xs text-emerald-400">已保存，检索用的特征已同步更新</p>
      )}

      {/*
        编辑标题与画面描述。**原生表单，不依赖 JS**：详情页本身是服务端直出
        的，编辑没理由依赖 hydration。
        描述一改就重编码（见 updateAssetMeta），否则库里存的是旧向量，表现为
        「描述已更新但按新描述搜不到」，这种失效不报错，只在检索时显现。
      */}
      <details className="mt-4 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2" data-tour="asset-edit">
        <summary className="cursor-pointer text-xs text-neutral-400 marker:content-none hover:text-neutral-200">
          编辑标题与画面描述
        </summary>
        <form
          action={`/api/library/${asset.id}/edit`}
          method="post"
          className="mt-3 space-y-3"
        >
          <input type="hidden" name="redirect" value={`/library/image/${asset.id}`} />

          <div>
            <label htmlFor="im-title" className="block text-xs text-neutral-400">
              标题
            </label>
            <input
              id="im-title"
              name="title"
              defaultValue={asset.title}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
            />
          </div>

          <div>
            <label htmlFor="im-caption" className="block text-xs text-neutral-400">
              画面描述
            </label>
            <textarea
              id="im-caption"
              name="caption"
              defaultValue={asset.caption ?? ''}
              rows={4}
              placeholder="描述这张图的内容，会影响按文字搜图的结果"
              className="mt-1 w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm leading-6 outline-none focus:border-neutral-500"
            />
            <p className="mt-1 text-xs text-neutral-400">
              留空表示只有画面本身参与检索。保存后要重新计算描述的特征，会等一两秒。
            </p>
          </div>

          <button
            type="submit"
            className="rounded-md bg-neutral-100 px-4 py-2 text-xs font-medium text-neutral-900"
          >
            保存
          </button>
        </form>
      </details>

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
            <div className="flex h-40 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-xs text-neutral-400">
              原图不在库内，无法预览
            </div>
          )}

          <p className="mt-4 text-sm leading-6 text-neutral-300">
            {asset.caption ?? (lightMode ? '（暂无画面描述，可按标题与标签检索）' : '（这张图还没有画面描述，只能按画面内容命中）')}
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
          <dl className="space-y-1 text-xs text-neutral-400">
            <div className="flex justify-between gap-3">
              <dt>画面特征</dt>
              <dd className="text-neutral-400">{lightMode ? '未启用（轻量）' : asset.hasVector ? '就绪' : '缺失'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>描述特征</dt>
              <dd className="text-neutral-400">{lightMode ? '未启用（轻量）' : asset.hasCaptionVector ? '就绪' : '缺失'}</dd>
            </div>
          </dl>

          <section>
            <h2 className="text-xs font-medium text-neutral-400">相似素材（{neighbours.length}）</h2>
            {neighbours.length === 0 ? (
              <p className="mt-2 text-xs text-neutral-400">
                {lightMode ? '轻量模式不启用相似素材推荐。' : '这张图没有可用的画面特征，算不出相似素材。'}
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
                        <span className="mt-0.5 block truncate text-xs text-neutral-400">
                          {n.caption ?? '（无描述）'}
                        </span>
                      </span>
                      <span className="flex-none text-xs tabular-nums text-neutral-400">
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
