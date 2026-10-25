import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTextDetail } from '@/lib/library'
import { embeddingEnabled } from '@/lib/embed'

export const dynamic = 'force-dynamic'

/**
 * 文本素材详情。**这一页之前不存在，列表里的文本也点不开**，于是入库的文本
 * 除了标题和字数，内容在界面上完全看不到，也没法编辑（文本的可编辑字段就是
 * 正文）。补上它，编辑才有地方落。
 *
 * 服务端直出，编辑用原生表单，整页不依赖 JS。提交到 /api/library/[id]/edit，
 * 服务端改完 redirect 回本页并带 edited 参数。
 */
export default async function TextDetailPage({
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

  const detail = getTextDetail(num)
  if (!detail) notFound()

  const { asset } = detail
  const lightMode = !embeddingEnabled()

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/library" className="text-xs text-neutral-400 underline hover:text-neutral-300">
        返回素材库
      </Link>

      <h1 className="mt-3 text-2xl font-semibold">{asset.title}</h1>
      <p className="mt-1 text-xs text-neutral-400">
        入库于 {asset.createdAt} · {asset.chars} 字 · {lightMode ? '关键词可检索' : asset.hasVector ? '可检索' : '暂不可检索'}
      </p>

      {cerr && <p className="mt-3 text-xs text-red-400">{cerr}</p>}
      {edited && (
        <p className="mt-3 text-xs text-emerald-400">已保存，检索用的特征已同步更新</p>
      )}

      {/*
        编辑区用原生表单 + details 收起。**不用 JS**：这条链路和删除一样，
        在客户端 JS 不执行的环境里必须仍然可用，而详情页本身是只读直出的，
        没有理由让编辑它依赖 hydration。
        标注一改就要重编码（见 updateAssetMeta 的说明），所以保存后有短暂
        等待，这里说明一下，别让人以为页面卡住。
      */}
      <details className="mt-6 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
        <summary className="cursor-pointer text-xs text-neutral-400 marker:content-none hover:text-neutral-200">
          编辑这段文本
        </summary>
        <form
          action={`/api/library/${asset.id}/edit`}
          method="post"
          className="mt-3 space-y-3"
        >
          <input type="hidden" name="redirect" value={`/library/text/${asset.id}`} />

          <div>
            <label htmlFor="t-title" className="block text-xs text-neutral-400">
              标题
            </label>
            <input
              id="t-title"
              name="title"
              defaultValue={asset.title}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
            />
          </div>

          <div>
            <label htmlFor="t-content" className="block text-xs text-neutral-400">
              内容
            </label>
            <textarea
              id="t-content"
              name="caption"
              defaultValue={asset.content}
              rows={14}
              className="mt-1 w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm leading-6 outline-none focus:border-neutral-500"
            />
          </div>

          <button
            type="submit"
            className="rounded-md bg-neutral-100 px-4 py-2 text-xs font-medium text-neutral-900"
          >
            保存
          </button>
        </form>
      </details>

      <section className="mt-6">
        <h2 className="text-xs font-medium text-neutral-400">内容</h2>
        <p className="mt-2 whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-900/60 p-4 text-sm leading-7 text-neutral-300">
          {asset.content}
        </p>
      </section>

      <Link
        href={`/?q=${encodeURIComponent(asset.content.slice(0, 200))}`}
        className="mt-4 inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
      >
        以此为查询词再检索
      </Link>
    </div>
  )
}
