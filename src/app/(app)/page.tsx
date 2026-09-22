import Link from 'next/link'
import { search } from '@/lib/search'
import { getRecentAssets, getLibraryList, type RecentAsset } from '@/lib/library'
import {
  listCollections,
  normalizeCollectionId,
  scopeLabel,
  ALL_COLLECTIONS,
} from '@/lib/collections'
import { toMediaUrl, toThumbUrl } from '@/lib/media'
import { fmtMs } from '@/lib/format'
import { ResultList, type ResultItem } from '@/components/ResultList'
import { CollectionScope } from '@/components/CollectionScope'

export const dynamic = 'force-dynamic'

/**
 * 检索页。两种形态，按有没有查询切换：
 *
 * **没有查询（落地态）**：检索栏居中放大，下面铺一排最近入库。空状态不是留白，
 *   是第一次来的人唯一能看到的东西。中央的输入框告诉他该干什么，最近入库告诉他
 *   库里有什么、从哪下手，两者缺一落地页就是一片空白。
 *
 * **有查询（结果态）**：检索栏收回顶部常驻，下面是结果流。此时查询本身就是上下文，
 *   输入框不需要再占主位，让位给结果。
 *
 * 这个切换不是审美选择：落地时把输入框放上面，首屏看到的是一行小框加大片空白，
 * 第一次用的人不知道要干什么；搜完之后还摆在中央，结果反而被挤到下面。
 *
 * 表单用原生 GET 提交，不依赖 JS。作用域来自 URL 的 lib 参数，提交时原样带回，
 * 换库不丢当前查询。
 *
 * 入库面板已拆去 /ingest 独立页：入库是「选文件然后等处理」的节奏，与检索
 * 「想想搜什么」不是一回事。
 */

const MODALITIES = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'text', label: '文本' },
] as const

/**
 * 定位播放的落点。**视频详情页而不是裸 mp4。**
 *
 * 裸 mp4（/api/media/xxx.mp4#t=18）点过去是浏览器自带播放器：侧边栏、逐字稿、
 * 关键帧全丢，看完那一句回不来。详情页把这些都留着，落在同一个播放器里，
 * 逐字稿在右手边，那一句还高亮。?t= 由 VideoTranscriptPanel 消费，
 * 它同时用这个参数给 video src 加 #t=，所以浏览器原生定位与页面状态都一致。
 *
 * 放在服务端算，是因为要用到 assetId 与当前作用域，而 URL 计算按本项目惯例
 * 一律留在服务端（客户端 import 含 node:path 的文件会让 Turbopack panic）。
 */
function libParam(collectionId: number): string {
  // 全部态写成 all。直接拼数字 0 的话 normalizeCollectionId 会把 0 当非法值
  // 回落成默认库，结果是「选了全部库，一过滤就悄悄回到默认库」且无任何提示。
  return collectionId === ALL_COLLECTIONS ? 'all' : String(collectionId)
}

function seekHref(assetId: number, collectionId: number, startMs: number): string {
  return `/library/video/${assetId}?t=${Math.floor(startMs / 1000)}&lib=${libParam(collectionId)}`
}

const KIND_LABEL: Record<RecentAsset['kind'], string> = {
  video: '视频',
  image: '图片',
  text: '文本',
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; m?: string; lib?: string; made?: string; cerr?: string }>
}) {
  const { q, m, lib, made, cerr } = await searchParams
  const collectionId = normalizeCollectionId(lib)
  const all = listCollections()
  const collections = all.map((c) => ({ id: c.id, name: c.name }))
  const madeId = made ? Number(made) : null
  const madeName = madeId ? (all.find((c) => c.id === madeId)?.name ?? null) : null
  const query = q?.trim() ?? ''
  // 类型筛选。m 参数后端一直支持，但此前没有任何 UI 能设置它，等于白做。
  const modality = (m === 'video' || m === 'image' || m === 'text' ? m : 'all') as
    | 'all'
    | 'video'
    | 'image'
    | 'text'

  let items: ResultItem[] = []
  let error: string | null = null
  let hitCount = 0

  if (query) {
    try {
      const hits = await search(query, {
        modality,
        collectionId,
      })
      hitCount = hits.length
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
              sentences: h.sentences.map((s) => ({
                ...s,
                seekHref: seekHref(h.assetId, collectionId, s.start_ms),
              })),
              videoUrl: toMediaUrl(h.assetPath),
              seekHref: seekHref(h.assetId, collectionId, h.startMs),
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

  // 类型筛选条。用链接而不是按钮：不需要 JS，且当前选中项一眼可见。
  // 落地态它筛的是「最近入库」那一排，结果态筛的是结果流，同一个参数两处生效。
  const filterBar = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-neutral-600">类型</span>
      {MODALITIES.map((mo) => {
        const params = new URLSearchParams()
        if (query) params.set('q', query)
        if (collectionId !== 1) {
          params.set('lib', collectionId === ALL_COLLECTIONS ? 'all' : String(collectionId))
        }
        if (mo.value !== 'all') params.set('m', mo.value)
        const href = params.toString() ? `/?${params.toString()}` : '/'
        const active = modality === mo.value
        return (
          <Link
            key={mo.value}
            href={href}
            className={`rounded border px-2 py-0.5 text-[11px] transition ${
              active
                ? 'border-neutral-100 bg-neutral-100 text-neutral-900'
                : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
            }`}
          >
            {mo.label}
          </Link>
        )
      })}
    </div>
  )

  // 检索表单两种形态共用，只差尺寸与按钮排布
  const form = (big: boolean) => (
    <form
      action="/"
      method="get"
      className={big ? 'w-full max-w-2xl' : 'flex gap-2'}
    >
      <input type="hidden" name="lib" value={libParam(collectionId)} />
      <input
        name="q"
        defaultValue={query}
        autoFocus={big}
        placeholder="搜什么，比如「网球场上的运动员」"
        className={
          big
            ? 'w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-base outline-none focus:border-neutral-500'
            : 'flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500'
        }
      />
      <button
        type="submit"
        className={
          big
            ? 'mt-3 w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm font-medium text-neutral-900'
            : 'rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900'
        }
      >
        检索
      </button>
    </form>
  )

  // --- 落地态：检索栏居中 + 最近入库 ---
  if (!query) {
    const counts = getLibraryList(collectionId).counts
    const empty = counts.video + counts.image + counts.text === 0
    // 类型传给 SQL，不取回来再筛。取回再筛会让「按文本看最近」变成
    // 「最近的 24 条里挑文本」，而那 24 条通常全是图片，结果整块空掉。
    const recent = empty ? [] : getRecentAssets(collectionId, 12, modality === 'all' ? undefined : modality)

    return (
      <div className="flex min-h-[calc(100vh-5rem)] flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <h1 className="text-3xl font-semibold text-neutral-100">找点什么</h1>
          <p className="mt-2 text-sm text-neutral-500">文字、画面、视频里的对白，一个框都能搜</p>
          <div className="mt-7 flex w-full justify-center">{form(true)}</div>
          <div className="mt-4">
            <CollectionScope
              collections={collections}
              currentId={collectionId}
              preserve={{ m: modality === 'all' ? '' : modality }}
              justMadeId={madeId}
              justMadeName={madeName}
            />
          </div>
          {cerr && <p className="mt-6 text-[11px] text-red-400">新建素材库失败：{cerr}</p>}

          {cerr && <p className="mt-6 text-[11px] text-red-400">新建素材库失败：{cerr}</p>}

          {empty && (
            <p className="mt-6 text-xs text-neutral-600">
              {scopeLabel(collectionId)}还没有素材，
              <Link href="/ingest" className="underline hover:text-neutral-400">
                先去入库
              </Link>
            </p>
          )}
        </div>

        {recent.length > 0 && (
          <section className="mt-10 border-t border-neutral-800 pt-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex-none text-sm font-medium text-neutral-300">最近入库</h2>
              <div className="flex-none">{filterBar}</div>
              <Link
                href="/library"
                className="text-[11px] text-neutral-500 underline hover:text-neutral-300"
              >
                查看全部
              </Link>
            </div>
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {recent.map((r) => (
                <li key={`${r.kind}-${r.id}`}>
                  <Link
                    href={r.detailHref}
                    className="block rounded-md border border-neutral-800 bg-neutral-900/60 p-2 transition hover:border-neutral-600"
                  >
                    {r.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={toThumbUrl(r.thumbUrl, 320) ?? r.thumbUrl}
                        alt=""
                        loading="lazy"
                        className="h-20 w-full rounded border border-neutral-800 object-cover"
                      />
                    ) : (
                      <div className="flex h-20 items-center justify-center rounded border border-neutral-800 bg-neutral-900 text-[11px] text-neutral-700">
                        {KIND_LABEL[r.kind]}
                      </div>
                    )}
                    <p className="mt-1.5 truncate text-[11px] text-neutral-300">{r.title}</p>
                    <p className="text-[10px] text-neutral-600">{KIND_LABEL[r.kind]}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    )
  }

  // --- 结果态：检索栏在顶部 ---
  return (
    <div className="mx-auto max-w-4xl">
      {form(false)}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <CollectionScope
          collections={collections}
          currentId={collectionId}
          preserve={{ q: query, m: modality === 'all' ? '' : modality }}
          justMadeId={madeId}
          justMadeName={madeName}
        />
        {filterBar}
      </div>

      {error && (
        <p className="mt-4 rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          推理服务不可用：{error}
        </p>
      )}

      {cerr && <p className="mt-4 text-[11px] text-red-400">新建素材库失败：{cerr}</p>}

      {!error && hitCount === 0 && (
        <p className="mt-6 text-sm text-neutral-400">
          「{query}」在{scopeLabel(collectionId)}里没有命中，
          <Link href="/library" className="underline hover:text-neutral-300">
            去素材库看看有什么
          </Link>
          ，或换个库试试。
        </p>
      )}

      {!error && hitCount > 0 && <ResultList items={items} />}
    </div>
  )
}
