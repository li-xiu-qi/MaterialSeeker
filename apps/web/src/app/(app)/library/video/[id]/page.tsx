import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getVideoDetail } from '@/lib/library'
import { normalizeCollectionId, getCollection } from '@/lib/collections'
import { fmtMs } from '@/lib/format'
import { VideoTranscriptPanel } from '@/components/VideoTranscriptPanel'
import { KeyframeGrid } from '@/components/KeyframeGrid'

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
    <div className="mx-auto w-full max-w-7xl">
      <header>
        <Link
          href="/library"
          title="返回素材库"
          className="inline-flex min-h-11 items-center rounded-sm text-xs text-neutral-300 outline-none transition hover:text-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-300/70"
        >
          返回素材库
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold tracking-tight text-neutral-50 sm:text-2xl">
              {asset.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-400">
              <span>{collection ? collection.name : '默认库'}</span>
              <span aria-hidden="true" className="text-neutral-700">
                ·
              </span>
              <span>入库于 {asset.createdAt}</span>
              {asset.durationMs !== null && (
                <>
                  <span aria-hidden="true" className="text-neutral-700">
                    ·
                  </span>
                  <span className="tabular-nums">视频 {fmtMs(asset.durationMs)}</span>
                </>
              )}
            </div>
          </div>

          {/*
            只改标题。视频描述在 frames.caption 上，是逐帧的，不提供整片描述输入框。
          */}
          <details className="relative flex-none" data-tour="asset-edit">
            <summary
              title="编辑这个素材的标题"
              className="cursor-pointer list-none rounded-md border border-neutral-800 px-3 py-2 text-xs text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200 marker:content-none"
            >
              编辑标题
            </summary>
            <form
              action={`/api/library/${asset.id}/edit`}
              method="post"
              className="absolute right-0 z-20 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl shadow-black/30"
            >
              <input
                type="hidden"
                name="redirect"
                value={`/library/video/${asset.id}${lib ? `?lib=${lib}` : ''}`}
              />
              <label htmlFor="vd-title" className="block text-xs text-neutral-400">
                标题
              </label>
              <input
                id="vd-title"
                name="title"
                defaultValue={asset.title}
                maxLength={120}
                className="mt-2 w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="submit"
                  title="保存新标题"
                  className="btn-primary px-4 py-2 text-xs"
                >
                  保存
                </button>
              </div>
            </form>
          </details>
        </div>
        {cerr && <p className="mt-3 text-xs text-red-400">{cerr}</p>}
        {edited && (
          <p className="mt-3 text-xs text-emerald-400">已保存，检索用的特征已同步更新</p>
        )}
      </header>

      <div className="mt-6">
        <VideoTranscriptPanel
          key={`${asset.id}:${transcript?.sentences.length ?? 0}`}
          mediaUrl={videoUrl}
          currentMs={currentMs}
          collectionId={collectionId}
          durationMs={asset.durationMs}
          sentences={transcript?.sentences ?? []}
        />
      </div>

      {!transcript || transcript.sentences.length === 0 ? (
        <p className="mt-6 text-xs text-neutral-400">
          这个视频没有转写结果，可能是没有对白或音轨缺失。
        </p>
      ) : null}

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-medium text-neutral-200">关键帧</h2>
          <span className="text-xs tabular-nums text-neutral-400">{frames.length} 个</span>
        </div>
        {frames.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">没有抽出的帧。</p>
        ) : (
          <KeyframeGrid key={asset.id} frames={frames} />
        )}
      </section>

      {transcript && transcript.chunks.length > 0 && (
        <section className="mt-8 border-t border-neutral-800 pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-neutral-300">检索块</h2>
            <span className="text-xs text-neutral-400">{transcript.chunks.length} 段</span>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            检索按块召回，这里解释某句话为什么会被一起命中。
          </p>
          <ul className="mt-3 grid gap-2 text-xs text-neutral-400 sm:grid-cols-3">
            {transcript.chunks.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-md bg-neutral-900/50 px-3 py-2"
              >
                <span className="tabular-nums text-neutral-400">
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
