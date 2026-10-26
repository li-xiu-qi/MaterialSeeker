import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getAudioDetail } from '@/lib/library'
import { normalizeCollectionId, getCollection } from '@/lib/collections'
import { fmtMs } from '@/lib/format'
import { VideoTranscriptPanel } from '@/components/VideoTranscriptPanel'

export const dynamic = 'force-dynamic'

/**
 * 音频素材详情。**与视频详情同一个骨架，只少关键帧那一节。**
 *
 * 布局语义照搬视频：播放器在左（主位），逐字稿在右（辅位），两者必须同屏，
 * 因为「点句子跳到那一秒」是这个页面的核心交互。音频没有画面，左侧只保留
 * 紧凑播放条；逐字稿维持可阅读高度，不与播放条强制等高。
 *
 * 逐字稿面板直接复用视频那个（kind="audio"），不为音频另写一份：点句跳转的
 * 逻辑只有一处，改的时候不会漏掉音频。
 *
 * t= 参数同样保留，音频定位也能是可分享的 URL。
 */
export default async function AudioDetailPage({
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

  const detail = getAudioDetail(num)
  if (!detail) notFound()

  const { asset, audioUrl, durationMs, tags, transcript } = detail
  const collectionId = normalizeCollectionId(lib)
  const collection = getCollection(collectionId)

  const tSec = Number(t)
  const currentMs = Number.isFinite(tSec) && tSec > 0 ? Math.floor(tSec * 1000) : null

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-baseline justify-between gap-3">
        <Link href="/library" className="text-xs text-neutral-400 underline hover:text-neutral-300">
          返回素材库
        </Link>
        <span className="text-xs text-neutral-400">
          {collection ? collection.name : '默认库'} · 入库于 {asset.createdAt}
          {durationMs ? ` · 时长 ${fmtMs(durationMs)}` : ''}
        </span>
      </div>

      <h1 className="mt-3 text-2xl font-semibold">{asset.title}</h1>

      {cerr && <p className="mt-2 text-xs text-red-400">{cerr}</p>}
      {edited && (
        <p className="mt-2 text-xs text-emerald-400">已保存，检索用的特征已同步更新</p>
      )}

      {/*
        只改标题与标签。音频没有「一段描述」这个字段：它的可检索文本全部来自
        逐字稿，而逐字稿是 ASR 产出的，不允许手改（改了就不再是「听到的」）。
        给一个描述输入框反而会造出一个检索不到的字段，所以不给。
      */}
      <details className="mt-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2" data-tour="asset-edit">
        <summary className="cursor-pointer text-xs text-neutral-400 marker:content-none hover:text-neutral-200">
          编辑标题与标签
        </summary>
        <form
          action={`/api/library/${asset.id}/edit`}
          method="post"
          className="mt-3 flex flex-wrap items-end gap-2"
        >
          <input
            type="hidden"
            name="redirect"
            value={`/library/audio/${asset.id}${lib ? `?lib=${lib}` : ''}`}
          />
          <div>
            <label htmlFor="ad-title" className="block text-xs text-neutral-400">
              标题
            </label>
            <input
              id="ad-title"
              name="title"
              defaultValue={asset.title}
              maxLength={120}
              className="mt-1 w-56 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
            />
          </div>
          <div>
            <label htmlFor="ad-tags" className="block text-xs text-neutral-400">
              标签
            </label>
            <input
              id="ad-tags"
              name="tags"
              defaultValue={tags.join('，')}
              placeholder="用逗号分开，例如：访谈，开场白"
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
          key={`${asset.id}:${transcript?.sentences.length ?? 0}`}
          kind="audio"
          mediaUrl={audioUrl}
          currentMs={currentMs}
          collectionId={collectionId}
          sentences={transcript?.sentences ?? []}
        />
      </div>

      {!transcript || transcript.sentences.length === 0 ? (
        <p className="mt-6 text-xs text-neutral-400">
          这个音频没有转写结果，可能是没有对白或音轨缺失。
        </p>
      ) : null}

      {transcript && transcript.chunks.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-300">检索块</h2>
          <p className="mt-1 text-xs text-neutral-400">
            检索是按块召回的，这里列出分块情况，用来解释某句话为什么会被一起命中。
          </p>
          <ul className="mt-3 space-y-1 text-xs text-neutral-400">
            {transcript.chunks.map((c) => (
              <li key={c.id} className="flex justify-between gap-3">
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
