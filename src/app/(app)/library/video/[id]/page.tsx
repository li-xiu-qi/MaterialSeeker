import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getVideoDetail } from '@/lib/library'
import { normalizeCollectionId, getCollection } from '@/lib/collections'
import { fmtMs } from '@/lib/format'
import { VideoTranscriptPanel } from '@/components/VideoTranscriptPanel'

export const dynamic = 'force-dynamic'

/**
 * 视频素材详情。**服务端取数，面板内部渐进增强。**
 *
 * 用独立页而不是抽屉：内容是长的（一部讲解视频几十句起），抽屉要内滚动；
 * 而且这个页面值得被收藏和分享链接。t= 参数让「定位到第几秒」变成可分享的
 * URL， whoever 打开都落在同一句上。
 *
 * 布局语义：视频左、逐字稿右。判据与理由写在 VideoTranscriptPanel 的注释里，
 * 这里只说结论——两者必须同屏，因为点句子跳转是这个页面的核心交互。
 *
 * 帧与检索块放在面板下面：它们不参与「点句跳转」这个交互，没必要同屏。
 */

export default async function VideoDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ t?: string; lib?: string; edited?: string; cerr?: string }>
}) {
  const { id } = await params
  const { t, lib, edited, cerr } = await searchParams
  const num = Number(id)
  if (!Number.isInteger(num) || num <= 0) notFound()

  const detail = getVideoDetail(num)
  if (!detail) notFound()

  const { asset, videoUrl, transcript, frames } = detail
  const collectionId = normalizeCollectionId(lib)
  const collection = getCollection(collectionId)

  const tSec = Number(t)
  const currentMs = Number.isFinite(tSec) && tSec > 0 ? Math.floor(tSec * 1000) : null

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-baseline justify-between gap-3">
        <Link href="/library" className="text-xs text-neutral-500 underline hover:text-neutral-300">
          返回素材库
        </Link>
        <span className="text-[11px] text-neutral-600">
          {collection ? collection.name : '默认库'} · 入库于 {asset.createdAt}
        </span>
      </div>

      <h1 className="mt-3 text-2xl font-semibold">{asset.title}</h1>

      {cerr && <p className="mt-2 text-[11px] text-red-400">{cerr}</p>}
      {edited && (
        <p className="mt-2 text-[11px] text-emerald-400">已保存，检索用的特征已同步更新</p>
      )}

      {/*
        只改标题。**视频没有「整片一个描述」这个字段**：视频的描述在
        frames.caption 上，是逐帧的，改一个不影响其他帧。所以这里不给
        「视频描述」输入框，给了反而是假的（存不进去，或在库里造一个检索
        不到的字段）。帧描述在各帧上单独改。
      */}
      <details className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
        <summary className="cursor-pointer text-[11px] text-neutral-400 marker:content-none hover:text-neutral-200">
          编辑标题
        </summary>
        <form
          action={`/api/library/${asset.id}/edit`}
          method="post"
          className="mt-3 flex flex-wrap items-end gap-2"
        >
          <input
            type="hidden"
            name="redirect"
            value={`/library/video/${asset.id}${lib ? `?lib=${lib}` : ''}`}
          />
          <div>
            <label htmlFor="vd-title" className="block text-[11px] text-neutral-500">
              标题
            </label>
            <input
              id="vd-title"
              name="title"
              defaultValue={asset.title}
              maxLength={120}
              className="mt-1 w-56 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
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

      <div className="mt-6">
        <VideoTranscriptPanel
          videoUrl={videoUrl}
          currentMs={currentMs}
          collectionId={collectionId}
          sentences={transcript?.sentences ?? []}
        />
      </div>

      {!transcript || transcript.sentences.length === 0 ? (
        <p className="mt-6 text-xs text-neutral-700">
          这个视频没有转写结果，可能是没有对白或音轨缺失。
        </p>
      ) : null}

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-300">关键帧（{frames.length}）</h2>
        {frames.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-700">没有抽出的帧。</p>
        ) : (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {frames.map((f) => (
              <li key={f.id} className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2">
                {f.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`${f.url}?w=320`}
                    alt=""
                    loading="lazy"
                    className="w-full rounded border border-neutral-800 object-cover"
                  />
                ) : (
                  <div className="flex h-20 items-center justify-center rounded border border-neutral-800 bg-neutral-900 text-[11px] text-neutral-700">
                    无预览
                  </div>
                )}
                <p className="mt-1.5 text-[11px] tabular-nums text-neutral-600">
                  {fmtMs(f.timestampMs)}
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
                  {f.caption ?? '（无描述）'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {transcript && transcript.chunks.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-300">检索块</h2>
          <p className="mt-1 text-[11px] text-neutral-700">
            检索是按块召回的，这里列出分块情况，用来解释某句话为什么会被一起命中。
          </p>
          <ul className="mt-3 space-y-1 text-[11px] text-neutral-500">
            {transcript.chunks.map((c) => (
              <li key={c.id} className="flex justify-between gap-3">
                <span className="tabular-nums text-neutral-600">
                  {fmtMs(c.startMs)} - {fmtMs(c.endMs)}
                </span>
                <span>
                  {c.strategy} · {c.sentenceCount} 句
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
