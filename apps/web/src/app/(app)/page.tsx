import { RECENT_LIMIT } from '@/lib/recent'
import { ASSET_KINDS } from '@/lib/mediaKind'
import { RESULT_PAGE, MAX_RESULT_SHOWN, resultParams } from '@/lib/searchPaging'
import Link from 'next/link'
import { search } from '@/lib/search'
import { embeddingEnabled } from '@/lib/embed'
import {
  getRecentAssets,
  getLibraryCounts,
  detailHrefFor,
  type RecentAsset,
} from '@/lib/library'
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

/**
 * 类型筛选的选项。**「全部」+ ASSET_KINDS 派生**，不手写四种模态。
 *
 * 手写过一份，加音频时漏改它的后果是：音频能入库、能搜到，但筛选条上没有
 * 「音频」这一项，用户以为音频不支持筛选。派生之后新增模态只改 mediaKind。
 */
const MODALITIES = [
  { value: 'all', label: '全部' },
  ...ASSET_KINDS.map((k) => ({ value: k.kind, label: k.label })),
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

/** 作用域写成 URL 参数。全部态必须是 all，写 0 会被当成非法值回落成默认库 */
function libQForResult(collectionId: number): string {
  return collectionId === ALL_COLLECTIONS ? 'all' : String(collectionId)
}

/**
 * 定位播放的落点。**视频与音频各一条**，同一套时间参数。
 *
 * 视频跳视频详情页而不是裸 mp4（理由见上面那段长注释），音频同理：跳音频详情页，
 * 逐字稿在右手边，那一句高亮，?t= 让 <audio> 直接落在那个秒数。
 *
 * 用 detailHrefFor 而不是在这里再拼一次四种模态的分支：那个 helper 是唯一
 * 事实源，这里再加一份的结果是加第五种模态时漏改它，而漏改不报错，只是
 * 定位播放落到 404。
 */
function seekHref(
  assetId: number,
  collectionId: number,
  startMs: number,
  kind: string,
): string {
  return `${detailHrefFor(kind, assetId)}?t=${Math.floor(startMs / 1000)}&lib=${libParam(collectionId)}`
}

/**
 * 最近入库卡片上的类型小字。**从 ASSET_KINDS 派生**，加模态不会漏。
 *
 * 早先这里手写三项，加音频时漏改的后果是卡片上那一行显示 undefined，而
 * tsc 查不出来（Record 的键来自 RecentAsset['kind']，加模态时那个联合类型
 * 一变，这里反而会报错——于是要么改这里，要么有人图省事把它改成 Partial）。
 */
const KIND_LABEL: Record<RecentAsset['kind'], string> = {
  video: '视频',
  image: '图片',
  audio: '音频',
  text: '文本',
}


export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    m?: string
    lib?: string
    /** 已显示的结果条数，翻页用 */
    s?: string
    made?: string
    cerr?: string
  }>
}) {
  const { q, m, lib, s, made, cerr } = await searchParams
  const collectionId = normalizeCollectionId(lib)
  const all = listCollections()
  const collections = all.map((c) => ({ id: c.id, name: c.name }))
  const madeId = made ? Number(made) : null
  const madeName = madeId ? (all.find((c) => c.id === madeId)?.name ?? null) : null
  const query = q?.trim() ?? ''
  const lightMode = !embeddingEnabled()
  // 类型筛选。m 参数后端一直支持，但此前没有任何 UI 能设置它，等于白做。
  const modality = (m === 'video' || m === 'image' || m === 'text' ? m : 'all') as
    | 'all'
    | 'video'
    | 'image'
    | 'text'

  let items: ResultItem[] = []
  let error: string | null = null
  let hitCount = 0
  // **已显示条数。** 从 URL 来，不用客户端 state：翻页是换一批结果，与「检索」一样
  // 该是能分享、能刷新的链接。
  const shown = Math.max(
    RESULT_PAGE,
    Math.min(Number(s) || RESULT_PAGE, MAX_RESULT_SHOWN),
  )
  // 翻页链接要带的当前态。在 query 与 modality 都定下来之后算，缺一个都不行。
  // 用现成的纯函数拼，不在页面里手写模板串——手写串漏一个参数不会报错，
  // 只会让翻页后搜索词或类型筛选悄悄没了。
  const resultParamsForPage = resultParams(query, modality, libQForResult(collectionId))

  if (query) {
    try {
      // topK 跟着 shown 走，否则翻了页也拿不到更多候选：每条路的截断是写死的，
      // 不穿透的话第二页和第一页内容完全相同。
      const hits = await search(query, {
        modality,
        collectionId,
        topK: shown,
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
                seekHref: seekHref(h.assetId, collectionId, s.start_ms, h.assetKind),
              })),
              videoUrl: toMediaUrl(h.assetPath),
              seekHref: seekHref(h.assetId, collectionId, h.startMs, h.assetKind),
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
      <span className="text-xs text-neutral-400">类型</span>
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
            className={`rounded border px-2 py-0.5 text-xs transition ${
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
        搜索
      </button>
    </form>
  )

  // --- 落地态：检索栏居中 + 最近入库 ---
  if (!query) {
    const counts = getLibraryCounts(collectionId)
    const empty = counts.video + counts.image + counts.text === 0
    // **只取最近 5 条，没有分页。** 这一排是引导不是浏览入口，要看全部有左侧
    // 「素材库」导航。理由与曾经矫枉过正的过程见 lib/recent。
    // 类型传给 SQL，不取回来再筛：按文本看最近时，若先取 5 条再筛，而那 5 条
    // 通常全是图片，整块就空掉了。
    const recent = empty
      ? []
      : getRecentAssets(collectionId, RECENT_LIMIT, modality === 'all' ? undefined : modality)
    // 标题上的总数，按当前类型算，否则「按图片筛」时报的是含视频文本的大数
    const total = empty
      ? 0
      : modality === 'all'
        ? counts.video + counts.image + counts.text
        : counts[modality]

    /*
      **hero 不撑满，上半部分用固定上边距。**

      原来这里是 min-h-[calc(100vh-5rem)]，为的是上下撑开、首屏不显得挤；后来主内容
      区改成独立滚动（见 AppShell），main 自己就是 h-screen，那层 min-h 会让 hero 比
      容器高出一点、多出一条滚不动的内部滚动条，于是改成 flex-1 撑开。

      flex-1 也有问题，而且更隐蔽：它把上半部分撑到占满视口，「最近入库」被推到首屏
      之外。用户看到的是「这个高度是不是太高了」——首屏只有检索栏和一大片空白，而
      「最近入库」要滚动才看得见。那一排不是装饰，是第一次来的人了解库里有什么的唯一
      线索，被挤到第二屏等于没有。

      改成 pt-14 固定留白：上面仍有呼吸感，但不吞掉下面的内容。视口 800px 上下时
      hero 加最近入库的第一行刚好在一屏内。空库时下面是「先去入库」提示，不撑满也
      说得过去——空库只在新装时出现，为它牺牲常态首屏不值。
    */
    return (
      <div className="flex flex-col">
        <div className="flex flex-col items-center px-4 pt-14">
          <h1 className="text-3xl font-semibold text-neutral-100">找点什么</h1>
          <p className="mt-2 text-sm text-neutral-400">文字、画面、视频里的对白，一个框都能搜</p>
          <div className="mt-6 flex w-full justify-center">{form(true)}</div>
          {lightMode && (
            <p className="mt-3 text-xs text-neutral-400">
              轻量模式：语音转写与画面描述保留，当前按关键词检索
            </p>
          )}
          <div className="mt-4">
            <CollectionScope
              collections={collections}
              currentId={collectionId}
              preserve={{ m: modality === 'all' ? '' : modality }}
              justMadeId={madeId}
              justMadeName={madeName}
            />
          </div>
          {cerr && <p className="mt-6 text-xs text-red-400">新建素材库失败：{cerr}</p>}

          {empty && (
            <p className="mt-6 text-xs text-neutral-400">
              {scopeLabel(collectionId)}还没有素材，
              <Link href="/ingest" className="underline hover:text-neutral-400">
                先去入库
              </Link>
            </p>
          )}
        </div>

        {recent.length > 0 && (
          <section className="mt-8 border-t border-neutral-800 pt-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex-none text-sm font-medium text-neutral-300">
                最近入库
                {/*
                  说清库里的总量。**不再显示「看到 N」**：只有 5 条且不分页，
                  「看到 5」是句废话；要传递的是「库里还有更多，去素材库看」。
                */}
                <span className="ml-2 text-xs font-normal text-neutral-400">
                  {total > 0 ? `库里共 ${total} 条` : ''}
                </span>
              </h2>
              <div className="flex-none">{filterBar}</div>
              <Link
                href="/library"
                className="text-xs text-neutral-400 underline hover:text-neutral-300"
              >
                去素材库看全部
              </Link>
            </div>
            {/*
              **两行五列，不是横向滚动一排。**

              这条改过三次，最终回到 grid 5 列 2 行。中间那版是横滚单排，问题两个：
              一是横滚没有可见滚动条，右边溢出的卡片看起来就是「没有了」，用户不
              知道还能滚；二是单排 10 张时每张只分到约 130px 宽，图片被压得只剩一条。

              改回 grid 后每张约 260px 宽（落地态全宽下 5 列均分），配 aspect-[16/9]
              自然高 146px，两行约 400px。页高约 886px，刚过常见视口一点，能滚但不
              空。窄屏退回 2 列与 3 列，那时折成五行或四行，靠页面滚动看全。

              **栏数必须与 RECENT_LIMIT 除得尽**：5 列放 10 张正好两行。留余数会让
              最后一行空几格，看着像少加载了几张、像列表坏了。
            */}
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {recent.map((r) => (
                <li key={`${r.kind}-${r.id}`}>
                  <Link
                    href={r.detailHref}
                    className="block rounded-md border border-neutral-800 bg-neutral-900/60 p-2 transition hover:border-neutral-600"
                  >
                    {/*
                      缩略图两条。

                      **一，不用 loading="lazy"。** 实测它在横滚容器里会失效（右侧
                      溢出的卡片一张都不加载，首屏出现五个空方框，用户以为图坏了）。
                      改回 grid 后那个坑不在了，但这一排总共十张 320px 缩略图，总量
                      很小，省这一次请求换不来什么，却要承担「某个断点下正好卡在加载
                      边界、看到空框」的风险。不值得。

                      **二，aspect-[16/9] 配 object-contain。** 5 列均分后每张约
                      260px 宽，配 146px 高正好是横图的自然比例，几乎铺满不留边。
                      竖图也不裁，在 16:9 的框里左右留白，内容是完整的。原来的
                      h-20 配 object-cover 把 16:9 横图上下切掉近一半。
                    */}
                    {r.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={toThumbUrl(r.thumbUrl, 320) ?? r.thumbUrl}
                        alt=""
                        className="aspect-[16/9] w-full rounded border border-neutral-800 bg-neutral-900 object-contain"
                      />
                    ) : (
                      <div className="flex aspect-[16/9] items-center justify-center rounded border border-neutral-800 bg-neutral-900 text-xs text-neutral-400">
                        {KIND_LABEL[r.kind]}
                      </div>
                    )}
                    <p className="mt-1.5 truncate text-xs text-neutral-300">{r.title}</p>
                    <p className="text-[10px] text-neutral-400">{KIND_LABEL[r.kind]}</p>
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
      {/*
        **结果态要有标题，落地态的「找点什么」不算。** 两者是不同性质的东西：
        落地态那句是邀请第一次来的人动手，属于内容文案；结果态这里要回答的是
        「我现在在哪个页面、这些结果是按什么来的」。改名前搜完之后页面上只有
        一个框和一堆结果，没有任何字样说明自己还在搜索这一页，而导航写的
        「搜索」与落地态标题又对不上，用户每次都得重新认。

        说清查询词与条数，是因为结果多时要能一眼看出「这是按哪个词搜出来的」。
      */}
      <h1 className="text-2xl font-semibold">
        搜索结果
        <span className="ml-2 text-sm font-normal text-neutral-400">
          「{query}」· {hitCount} 条
        </span>
      </h1>

      {form(false)}
      {lightMode && (
        <p className="mt-2 text-xs text-neutral-400">
          轻量模式：语音转写与画面描述保留，当前按关键词检索
        </p>
      )}

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

      {cerr && <p className="mt-4 text-xs text-red-400">新建素材库失败：{cerr}</p>}

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

      {!error && hitCount > shown && (
        <Link
          href={`/?${resultParamsForPage.toString()}&s=${shown + RESULT_PAGE}`}
          className="mt-4 block w-full rounded-md border border-neutral-800 px-3 py-2 text-center text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
        >
          显示更多结果（还有 {hitCount - shown} 条）
        </Link>
      )}
    </div>
  )
}
