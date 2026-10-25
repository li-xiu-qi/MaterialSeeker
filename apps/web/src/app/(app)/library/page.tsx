import {
  COL_OPTIONS,
  parseCols,
  LIST_CLS,
  THUMB_W,
  COVER_W,
} from '@/lib/layout'
import { MAX_PAGE, type LibraryFilter } from '@/lib/libraryFilter'
import { ASSET_KINDS } from '@/lib/mediaKind'
import { fmtMs } from '@/lib/format'
import { ScrollSafeSelect } from '@/components/ScrollSafeSelect'
import Link from 'next/link'
import { embeddingEnabled } from '@/lib/embed'

/**
 * 类型筛选。**与检索页同源**：ASSET_KINDS 派生，不手写四种模态。
 *
 * 手写过一份，加音频时漏改的后果不是界面少一个按钮，而是 as const 把 kind 的
 * 取值锁死成三项，listLibrary 收到不含 'audio' 的联合类型直接编译不过——这类
 * 错会被当成「我的改动有问题」查半天，而根因是两份本应同源的列表各自演化。
 */
const FILTERS = [
  { value: 'all', label: '全部' },
  ...ASSET_KINDS.map((k) => ({ value: k.kind, label: k.label })),
] as const

/** URL 上传来的 k 只认这四种，别的（含拼错）当没筛，不是报错 */
const KIND_SET = new Set<string>(ASSET_KINDS.map((k) => k.kind))


import { getLibraryList } from '@/lib/library'
import { toMediaUrl, toThumbUrl } from '@/lib/media'
import { LibraryDeleteButton } from '@/components/LibraryDeleteButton'
import { LibraryEditButton } from '@/components/LibraryEditButton'
import { CollectionScope } from '@/components/CollectionScope'
import { CollectionMenu } from '@/components/CollectionMenu'
import { BulkDeleteButton } from '@/components/BulkDeleteButton'
import { BulkCaptionButton } from '@/components/BulkCaptionButton'
import {
  listCollections,
  normalizeCollectionId,
  scopeLabel,
  ALL_COLLECTIONS,
} from '@/lib/collections'

export const dynamic = 'force-dynamic'

/**
 * 素材库列表。**服务端直出，不靠客户端 fetch。**
 *
 * 这一条是踩过之后才这么写的：客户端 fetch 版本一旦 hydration 不生效，
 * 页面就永久停在「加载中…」，而列表本身是只读的，没有任何理由要等 JS。
 * 现在这个页面的内容在 HTML 里就是全的，JS 挂不挂都能看。
 *
 * 分页走 URL 参数 ?n=<每一类显示多少条>，不用客户端 state，同样是为了不依赖 JS。
 * **三类共用一个 n，不再只有图片能翻页**：原来 limit 只作用于图片，视频与文本
 * 实际是全量渲染的，一个库有几百个视频就渲染几百张卡片。
 * 删除是唯一需要 JS 的动作（要发 DELETE），做成一个小岛，JS 失效时只是删不了，
 * 不影响浏览。
 */

const PAGE = 24

/**
 * 一条素材的多选框。**只在多选态渲染，默认连 DOM 里都没有。**
 *
 * 用户抱怨了三次的是它的外观与位置：默认常驻时每张卡片角落一个白框，扫视
 * 时全是噪点；多栏下还和操作按钮挤在同一行，那条行只有 57px 宽。所以改成由
 * 「多选」入口带 ?select=1 才出现，退出多选即还原——URL 一切整页重出，选择态
 * 自然清空，不需要额外的清除逻辑，也不需要客户端 state（本页其他控件也都走
 * URL，JS 失效时多选照样可用）。
 *
 * 外观不沿用浏览器原生 checkbox：暗色页面上那是个不受主题控制的白框。
 * appearance-none 去掉原生外观后自己画，选中填白并画一个勾（勾用 ::after
 * 的 content 插，字面量写死，Tailwind 构建时才扫得到）。
 */
function AssetCheckbox({
  name,
  value,
  title,
}: {
  name: string
  value: number
  title: string
}) {
  return (
    <input
      type="checkbox"
      name={name}
      value={value}
      aria-label={`选择 ${title}`}
      className="mt-1 h-4 w-4 flex-none cursor-pointer appearance-none rounded-sm border border-neutral-600 bg-neutral-900 checked:border-neutral-100 checked:bg-neutral-100 checked:after:block checked:after:h-4 checked:after:w-4 checked:after:text-center checked:after:text-[10px] checked:after:leading-4 checked:after:text-neutral-900 checked:after:content-['✓']"
    />
  )
}

/**
 * 一组批量操作按钮。**靠 formaction 指向不同端点，复选框必须真的在这个 form 里。**
 *
 * 之前埋的坑：复选框放在列表里、按钮用 form 属性远程关联一个藏在页面底部的
 * form，注释里写的理由是「把整段列表包进 form 里 HTML 非法」（这个判断是错的）。
 * 结果是复选框不属于任何表单，提交时勾选的 id 全丢，四个按钮全部空转，而接口
 * 本身是对的，所以在页面上只表现为「点了提示没有选中任何素材」，很难往表单
 * 关联上想。
 *
 * 现在每组列表包一个真实 form，四个按钮用 formaction 各指各的端点，目标库
 * 下拉用 form 属性挂进同一个 form（它只归属一个 form，可以这么挂）。
 *
 * 多选态之外这里只剩一个「多选」入口：五个按钮加一个下拉在日常浏览时是纯噪音，
 * 而它们每一刻都不能用（没有勾选对象）。要做的一张表也简单——非多选态不渲染
 * 它们，多选态才出现，末尾给「完成」退出。
 */
function BulkBar({
  formId,
  targets,
  currentId,
  wide,
  selecting,
  enterHref,
  exitHref,
  caption,
}: {
  formId: string
  targets: Array<{ id: number; name: string }>
  currentId: number
  /** 单栏为 true。多栏时复选框被提到卡片左上角，提示文案要跟着改 */
  wide: boolean
  /** 是否处于多选态 */
  selecting: boolean
  enterHref: string
  exitHref: string
  /**
   * 要不要在这一组给「AI 标注」。**只有图片组给**：标注是「看一眼画面然后写
   * 描述」，视频与音频的内容在逐字稿里，没有画面可看。给错了入口的结果是用户
   * 勾一批视频点下去，然后逐条报错。
   */
  caption?: boolean
}) {
  const btn =
    'rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
  if (!selecting) {
    return (
      <Link
        href={enterHref}
        className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
      >
        多选
      </Link>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 目标库下拉同样会吞滚轮，理由与取舍见 ScrollSafeSelect */}
      <ScrollSafeSelect
        name="to"
        form={formId}
        defaultValue=""
        aria-label="目标素材库"
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-300 outline-none focus:border-neutral-500"
      >
        <option value="">选择目标库</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id} disabled={t.id === currentId}>
            {t.name}
            {t.id === currentId ? '（当前）' : ''}
          </option>
        ))}
      </ScrollSafeSelect>
      <button type="submit" form={formId} formAction="/api/library/move" formMethod="post" className={btn}>
        移动到库
      </button>
      <button
        type="submit"
        form={formId}
        formAction="/api/library/copy"
        formMethod="post"
        className={btn}
      >
        复制到库
      </button>
      <button
        type="submit"
        form={formId}
        formAction="/api/library/export/form"
        formMethod="post"
        className={btn}
      >
        导出所选
      </button>
      {caption && <BulkCaptionButton formId={formId} />}
      <button
        type="submit"
        form={formId}
        formAction="/api/library/bulk/form"
        formMethod="post"
        className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-red-700 hover:text-red-300"
      >
        删除所选
      </button>
      <Link href={exitHref} className={btn}>
        退出多选
      </Link>
      <span className="text-xs text-neutral-400">
        {wide ? '勾选左侧方框' : '勾选卡片左上角'}
      </span>
    </div>
  )
}

/**
 * 一组的「显示更多」。**没有更多时返回 null，连 DOM 里都不进。**
 *
 * remaining 由调用方用服务端给的 total 减已显示条数算出。**页面不自己有没有更多**：
 * 自己数只能数自己取回来的那几条，永远看不到「还有更多」这一态。
 *
 * 链接带 keep（作用域、类型、关键词、栏数的当前态），再叠 n=已显示条数 + 一页。
 * 走 URLSearchParams 而不是手写模板串，是漏带某个参数时不会静默丢掉当前视图：
 * 手写串漏一个 kw，翻页后筛选就没了，而用户看不出是翻页弄丢的还是自己弄丢的。
 *
 * **keep 与 shown 显式传入，不从页面闭包里取。** 这个组件定义在页面组件之外，
 * 那时 shown 与 keepForCols 都还不存在；靠闭包捕获只会拿到 undefined，而 undefined
 * 拼进 URL 变成 n=NaN，不报错，表现为「点了显示更多回到第一页」。
 */
function MoreLink({
  keep,
  shown,
  remaining,
  unit,
}: {
  keep: URLSearchParams
  shown: number
  remaining: number
  unit: string
}) {
  if (remaining <= 0) return null
  return (
    <Link
      href={`/library?${keep.toString()}&n=${shown + PAGE}`}
      className="mt-3 block w-full rounded-md border border-neutral-800 px-3 py-2 text-center text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
    >
      显示更多（还有 {remaining} {unit}）
    </Link>
  )
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{
    n?: string
    lib?: string
    k?: string
    kw?: string
    c?: string
    made?: string
    renamed?: string
    deleted?: string
    bulkRemoved?: string
    moved?: string
    copied?: string
    cerr?: string
    select?: string
  }>
}) {
  const {
    n,
    lib,
    k,
    kw,
    c,
    made,
    renamed,
    deleted,
    bulkRemoved: bulkRemovedCount,
    moved: movedCount,
    copied: copiedCount,
    cerr,
    select,
  } = await searchParams
  const collectionId = normalizeCollectionId(lib)
  const lightMode = !embeddingEnabled()
  // n 由用户经 URL 给，钳在 [PAGE, MAX_PAGE]：小于一页没有意义（会漏看），
  // 大于上限是手打参数，服务端还会再钳一次，两边同一个常数。
  const shown = Math.max(PAGE, Math.min(Number(n) || PAGE, MAX_PAGE))
  // 类型与关键词筛选。关键词按标题与画面描述做模糊匹配，理由见 libraryWhere：
  // 中文不走 FTS，那条路默认 tokenizer 不分词，LIKE 对中文够用也不依赖分词。
  const kind = k && KIND_SET.has(k) ? (k as LibraryFilter['kind']) : undefined
  const keyword = (kw ?? '').trim()
  const all = listCollections()
  const collections = all.map((c) => ({ id: c.id, name: c.name }))
  const madeId = made ? Number(made) : null
  const madeName = madeId ? (all.find((c) => c.id === madeId)?.name ?? null) : null
  const renamedId = renamed ? Number(renamed) : null
  const deletedId = deleted ? Number(deleted) : null
  const deletedName = deletedId ? (all.find((c) => c.id === deletedId)?.name ?? null) : null
  const bulkRemoved = bulkRemovedCount ? Number(bulkRemovedCount) : null
  const moved = movedCount ? Number(movedCount) : null
  const copied = copiedCount ? Number(copiedCount) : null
  // 拼进 URL 时必须把全部态写成 all。直接拼数字 0 的话，normalizeCollectionId
  // 会把 0 当非法值回落成默认库，结果是「选了全部库，一过滤就悄悄回到默认库」
  // 且没有任何提示。
  const libQ = collectionId === ALL_COLLECTIONS ? 'all' : String(collectionId)
  // **筛选与 limit 都交给 SQL，页面不自己切。** 原来的写法是全量取回再
  // JS filter，limit 又只切图片一类，视频与文本照样全量渲染、「大规模内容时有点卡」
  // 卡的就是取数那一步。现在三个数都来自 SQL，页面只负责把它们摆出来。
  const data = getLibraryList(collectionId, { kind, q: keyword, limit: shown })
  // 栏数与由它推出的布局。放在这里是因为它依赖 libQ 与 shown，两者在上面才算出来。
  const cols = parseCols(c)
  /** 单栏时卡片是横排（缩略图在左），多栏时改竖排，否则窄栏里图和字挤在一起 */
  const wide = cols === 1
  const listCls = LIST_CLS[cols]
  /**
   * 多选态。**只认字面量 '1'，任何其他值（含空串）都是浏览态。**
   * 这样退出只需把参数拿掉，不存在「=0 也算开」的歧义。
   */
  const selecting = select === '1'
  /** 给站内链接挂上多选态：栏数、类型、批量操作回跳都要带，否则一步就退出多选 */
  const withSelect = (href: string) =>
    selecting ? `${href}${href.includes('?') ? '&' : '?'}select=1` : href
  // 批量操作完成后回到当前视图：栏数、筛选、已加载条数都要带上，否则用户
  // 在多栏状态下操作完被弹回单栏首页。多选态也要带，否则删完一批就得再点一次「多选」。
  const backHref = withSelect(
    `/library?lib=${libQ}&k=${kind ?? 'all'}&kw=${encodeURIComponent(
      keyword,
    )}&c=${cols}${shown > PAGE ? `n=${shown}` : ''}`,
  )
  /** 栏数切换时要一并带上的参数：丢了 n 会把已加载的条目缩回一页 */
  const keepForCols = new URLSearchParams({
    lib: libQ,
    k: kind ?? 'all',
    kw: keyword,
    ...(shown > PAGE ? { n: String(shown) } : {}),
  })
  /** 多选入口与退出。exit 刻意不加 select：它要的正是「把参数拿掉」的那个链接 */
  const enterSelectHref = `/library?${keepForCols.toString()}&select=1`
  const exitSelectHref = `/library?${keepForCols.toString()}`

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">素材库</h1>
      <p className="mt-1 text-sm text-neutral-400">
        当前范围：{scopeLabel(collectionId)}
        {data.allCollections ? ' · 每条素材标注了所属库' : ''}
      </p>

      {cerr && <p className="mt-2 text-xs text-red-400">{cerr}</p>}
      {deletedName && (
        <p className="mt-2 text-xs text-emerald-400">已删除素材库「{deletedName}」</p>
      )}
      {bulkRemoved && (
        <p className="mt-2 text-xs text-emerald-400">
          已删除 {bulkRemoved} 条素材（文件仍保留在素材目录）
        </p>
      )}
      {/*
        管理菜单（⋯）与库选择同一行。它是低频操作，做成通栏折叠区会占到跟素材
        列表一个量级的视觉分量，压不住它该占的地方；改成按钮后与「当前库」
        「+ 新建」聚成一组库级操作，不额外占垂直空间，用户找的时候也在同一处看到。
        只管当前库，不列其他库：切库用旁边的下拉一步就能做，菜单里再列一遍所有
        库是重复信息，还会诱导用户在目标库不在眼前时改名或删除。
      */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CollectionScope
          collections={collections}
          currentId={collectionId}
          label="当前库"
          preserve={{ k: kind ?? 'all', kw: keyword }}
          justMadeId={madeId}
          justMadeName={madeName}
        />
        <CollectionMenu
          collectionId={collectionId}
          collectionName={
            collectionId === ALL_COLLECTIONS
              ? null
              : (all.find((c) => c.id === collectionId)?.name ?? null)
          }
          isDefault={all.some((c) => c.id === collectionId && c.id === 1)}
          // **计数从 ASSET_KINDS 求和，不手写三项。** 手写过，加音频时少算一类，
          // 表现是删库确认框里显示的素材数比实际少（「默认库里有 178 个素材」，
          // 而实际 179）。少报数字比多报更危险：用户以为删得干净。
          assetCount={ASSET_KINDS.reduce((n, k) => n + data.counts[k.kind], 0)}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-400">
        {ASSET_KINDS.map((k) => (
          <span key={k.kind}>
            {k.label} {data.counts[k.kind]}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-neutral-400">栏数</span>
          {COL_OPTIONS.map((o) => {
            const active = cols === Number(o.value)
            const href = new URLSearchParams(keepForCols)
            href.set('c', o.value)
            return (
              <Link
                key={o.value}
                href={withSelect(`/library?${href.toString()}`)}
                className={`rounded border px-2 py-0.5 text-xs transition ${
                  active
                    ? 'border-neutral-100 bg-neutral-100 text-neutral-900'
                    : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
                }`}
              >
                {o.label}
              </Link>
            )
          })}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-neutral-400">类型</span>
          {FILTERS.map((f) => {
            const active = (kind ?? 'all') === f.value
            return (
              <Link
                key={f.value}
                href={withSelect(
                  `/library?lib=${libQ}&k=${f.value}&kw=${encodeURIComponent(keyword)}`,
                )}
                className={`rounded border px-2 py-0.5 text-xs transition ${
                  active
                    ? 'border-neutral-100 bg-neutral-100 text-neutral-900'
                    : 'border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
                }`}
              >
                {f.label}
              </Link>
            )
          })}
        </span>
      </div>

      <form action="/library" method="get" className="mt-3 flex gap-2">
        <input type="hidden" name="lib" value={libQ} />
        <input type="hidden" name="k" value={kind ?? 'all'} />
        {selecting && <input type="hidden" name="select" value="1" />}
        <input
          name="kw"
          defaultValue={keyword}
          placeholder="按标题或画面描述筛选"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500"
        >
          筛选
        </button>
        {keyword && (
          <Link
            href={`/library?lib=${libQ}&k=${kind ?? 'all'}`}
            className="self-center text-xs text-neutral-400 underline hover:text-neutral-300"
          >
            清除
          </Link>
        )}
      </form>

      <section className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-neutral-300">视频</h2>
          {data.video.length > 0 && (
            <BulkBar
              formId="bulk-video"
              targets={collections}
              currentId={collectionId}
              wide={wide}
              selecting={selecting}
              enterHref={enterSelectHref}
              exitHref={exitSelectHref}
            />
          )}
        </div>
        {data.video.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">
            {kind && kind !== 'video'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的视频`
                : '还没有视频素材'}
          </p>
        ) : (
          /* 复选框必须包在真实 form 里。用 form 属性远程关联按钮是不行的：那样
             复选框不属于任何表单，提交时勾选的 id 全丢，四个按钮全部空转。 */
          <form id="bulk-video" action="/api/library/bulk/form" method="post">
            <input type="hidden" name="redirect" value={backHref} />
            <ul className={listCls}>
              {data.video.map((v) => {
                const cover = toThumbUrl(v.cover, COVER_W[cols])
                return (
                  <li
                    key={v.id}
                    className={
                      wide
                        ? 'rounded-md border border-neutral-800 bg-neutral-900/60 p-4'
                        : 'flex flex-col rounded-md border border-neutral-800 bg-neutral-900/60 p-2'
                    }
                  >
                    {/*
                      多选态才渲染这一行。浏览态连 input 都不进 DOM：用户三次抱怨
                      每张卡片角落一个白框是噪音，而它在没有勾选对象时也确实没用。
                      单栏时操作按钮原本和复选框挤在同一行，浏览态挪到右侧独立一行。
                    */}
                    {selecting ? (
                      <div
                        className={
                          wide
                            ? 'flex items-start gap-3'
                            : 'mb-1.5 flex items-center justify-between gap-1.5'
                        }
                      >
                        <AssetCheckbox name="video" value={v.id} title={v.title} />
                        {!wide && (
                          <span className="flex flex-none items-center gap-1">
                            <LibraryEditButton
                              id={v.id}
                              kind="video"
                              title={v.title}
                              annotation=""
                              annotationLabel=""
                              tags={v.tags}
                            />
                            <LibraryDeleteButton id={v.id} title={v.title} />
                          </span>
                        )}
                      </div>
                    ) : (
                      !wide && (
                        <div className="mb-1.5 flex items-center justify-end gap-1">
                          <span className="flex flex-none items-center gap-1">
                            <LibraryEditButton
                              id={v.id}
                              kind="video"
                              title={v.title}
                              annotation=""
                              annotationLabel=""
                              tags={v.tags}
                            />
                            <LibraryDeleteButton id={v.id} title={v.title} />
                          </span>
                        </div>
                      )
                    )}
                    <Link
                      href={`/library/video/${v.id}`}
                      className={wide ? 'flex min-w-0 flex-1 items-start gap-3' : 'block min-w-0'}
                    >
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={cover}
                          alt=""
                          className={
                            wide
                              ? 'h-20 w-36 flex-none rounded border border-neutral-800 object-cover'
                              : 'aspect-video w-full rounded border border-neutral-800 object-cover'
                          }
                          loading="lazy"
                        />
                      ) : (
                        <div
                          className={
                            wide
                              ? 'h-20 w-36 flex-none rounded border border-neutral-800 bg-neutral-800'
                              : 'aspect-video w-full rounded border border-neutral-800 bg-neutral-800'
                          }
                        >
                          无封面
                        </div>
                      )}
                      <span className={wide ? 'min-w-0 flex-1' : 'mt-1.5 block min-w-0'}>
                        <span className="block truncate text-sm text-neutral-200">{v.title}</span>
                        {/*
                          「N 句 · N 块 · N 帧」在窄栏里会被拆成一个数字一行，卡片
                          高度失控（实测 354px）。多栏时只留最有信息量的一句，要看
                          全的去详情页。
                        */}
                        <span className="mt-1 block text-xs text-neutral-400">
                          {wide ? (
                            `${v.sentences} 句 · ${v.chunks} 块 · ${v.frames} 帧 · 查看逐字稿与关键帧`
                          ) : (
                            <span className="block truncate">{v.sentences} 句 · 查看逐字稿</span>
                          )}
                        </span>
                      </span>
                    </Link>
                    {wide && (
                      <span className="flex flex-none items-center gap-1.5">
                        <LibraryEditButton
                          id={v.id}
                          kind="video"
                          title={v.title}
                          annotation=""
                          annotationLabel=""
                          tags={v.tags}
                        />
                        <LibraryDeleteButton id={v.id} title={v.title} />
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </form>
        )}
        <MoreLink
          keep={keepForCols}
          shown={shown}
          remaining={data.total.video - data.video.length}
          unit="个"
        />
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-neutral-300">图片</h2>
          {data.image.length > 0 && (
            <BulkBar
              formId="bulk-image"
              targets={collections}
              currentId={collectionId}
              wide={wide}
              selecting={selecting}
              enterHref={enterSelectHref}
              exitHref={exitSelectHref}
              caption
            />
          )}
        </div>
        {data.image.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">
            {kind && kind !== 'image'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的图片`
                : '还没有图片素材'}
          </p>
        ) : (
          <form id="bulk-image" action="/api/library/bulk/form" method="post">
            <input type="hidden" name="redirect" value={backHref} />
            <ul className={listCls}>
              {data.image.map((im) => {
                const thumb = toThumbUrl(im.mediaPath, THUMB_W[cols])
                const thumbCls = wide
                  ? 'h-24 w-32 flex-none rounded border border-neutral-800 object-cover'
                  : 'aspect-[4/3] w-full rounded border border-neutral-800 object-cover'
                return (
                  <li
                    key={im.id}
                    className={
                      wide
                        ? 'rounded-md border border-neutral-800 bg-neutral-900/60 p-4'
                        : 'flex flex-col rounded-md border border-neutral-800 bg-neutral-900/60 p-2'
                    }
                  >
                    {/*
                      多栏时把复选框与操作按钮提到卡片顶部一行。这是踩过之后才这么
                      摆的：第一版把它们留在原来的位置（竖排后就在图下面），结果
                      复选框和按钮被缩略图挤成一条 57px 宽的竖线，整张卡片高 292px，
                      四栏一屏只能看两三张。列宽是从 DOM 量出来的（215px），不是猜的。

                      现在整行只在多选态出现（理由见视频组），浏览态操作按钮独立成行。
                    */}
                    {selecting ? (
                      <div
                        className={
                          wide
                            ? 'flex items-start gap-3'
                            : 'mb-1.5 flex items-center justify-between gap-1.5'
                        }
                      >
                        <AssetCheckbox name="image" value={im.id} title={im.title} />
                        {!wide && (
                          <span className="flex flex-none items-center gap-1">
                            <LibraryEditButton
                              id={im.id}
                              kind="image"
                              title={im.title}
                              annotation={im.caption ?? ''}
                              annotationLabel="画面描述"
                              tags={im.tags}
                            />
                            <LibraryDeleteButton id={im.id} title={im.title} />
                          </span>
                        )}
                      </div>
                    ) : (
                      !wide && (
                        <div className="mb-1.5 flex items-center justify-end gap-1">
                          <span className="flex flex-none items-center gap-1">
                            <LibraryEditButton
                              id={im.id}
                              kind="image"
                              title={im.title}
                              annotation={im.caption ?? ''}
                              annotationLabel="画面描述"
                              tags={im.tags}
                            />
                            <LibraryDeleteButton id={im.id} title={im.title} />
                          </span>
                        </div>
                      )
                    )}
                    <Link
                      href={`/library/image/${im.id}`}
                      className={wide ? 'flex min-w-0 flex-1 items-start gap-3' : 'block min-w-0'}
                    >
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb}
                          alt={im.caption ?? ''}
                          className={thumbCls}
                          loading="lazy"
                        />
                      ) : (
                        <div
                          className={
                            wide
                              ? 'h-24 w-32 flex-none rounded border border-neutral-800 bg-neutral-800'
                              : 'aspect-[4/3] w-full rounded border border-neutral-800 bg-neutral-800'
                          }
                        >
                          无预览
                        </div>
                      )}
                      <span className={wide ? 'min-w-0 flex-1' : 'mt-1.5 block min-w-0'}>
                        <span className="block truncate text-sm text-neutral-200">{im.title}</span>
                        {/*
                          描述在两栏与四栏都锁两行：一栏给足空间可以全展示，窄栏全
                          展示会把卡片撑到老长，扫视时反而看不清。截断用 line-clamp，
                          不用 truncate（后者只断一行）。
                        */}
                        <span
                          className={
                            wide
                              ? 'mt-1 block text-xs text-neutral-400'
                              : 'mt-0.5 block text-xs leading-4 text-neutral-400 line-clamp-2'
                          }
                        >
                          {im.caption ?? '（无说明）'}
                        </span>
                        <span className="mt-1 block text-xs text-neutral-400">
                          {lightMode ? '关键词可检索' : im.hasVector ? '可搜索' : '暂不可搜索'}
                          {!lightMode && im.hasCaptionVector && wide ? ' · 可按描述搜索' : ''}
                          {!wide && ' · 查看大图与相似素材'}
                        </span>
                      </span>
                    </Link>
                    {wide && (
                      <span className="flex flex-none items-center gap-1.5">
                        <LibraryEditButton
                          id={im.id}
                          kind="image"
                          title={im.title}
                          annotation={im.caption ?? ''}
                          annotationLabel="画面描述"
                          tags={im.tags}
                        />
                        <LibraryDeleteButton id={im.id} title={im.title} />
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </form>
        )}
        <MoreLink
          keep={keepForCols}
          shown={shown}
          remaining={data.total.image - data.image.length}
          unit="张"
        />
      </section>

      {/*
        **音频段。** 位置在图片之后、文本之前，与检索页类型筛选的顺序一致
        （ASSET_KINDS：视频、图片、音频、文本）——同一份素材在两页的排列不同
        会让人以为漏了一类。

        与视频段的结构差异，全部来自「音频没有帧」：
        - 没有封面图位。**不拿波形图充当封面**：那要为每个卡片多解码一次音频，
          而卡片上那一小块只是提示「库里有什么」。音频按时长与句数表达自己。
        - 没有「查看逐字稿与关键帧」那句 meta，只有句数与块数。
        - 编辑框只给标题与标签：音频没有整片描述字段（描述是逐帧的，音频没有帧）。
      */}
      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-neutral-300">音频</h2>
          {data.audio.length > 0 && (
            <BulkBar
              formId="bulk-audio"
              targets={collections}
              currentId={collectionId}
              wide={wide}
              selecting={selecting}
              enterHref={enterSelectHref}
              exitHref={exitSelectHref}
            />
          )}
        </div>
        {data.audio.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">
            {kind && kind !== 'audio'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的音频`
                : '还没有音频素材'}
          </p>
        ) : (
          <form id="bulk-audio" action="/api/library/bulk/form" method="post">
            <input type="hidden" name="redirect" value={backHref} />
            <ul className={listCls}>
              {data.audio.map((au) => (
                <li
                  key={au.id}
                  className={
                    wide
                      ? 'rounded-md border border-neutral-800 bg-neutral-900/60 p-4'
                      : 'flex flex-col rounded-md border border-neutral-800 bg-neutral-900/60 p-2'
                  }
                >
                  <div className="flex gap-3">
                    {selecting && (
                      <AssetCheckbox
                        name="audio"
                        value={au.id}
                        title={au.title}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <Link href={`/library/audio/${au.id}`} className="block min-w-0">
                        <p className="truncate text-sm text-neutral-200">{au.title}</p>
                        <p className="mt-1 text-xs text-neutral-400">
                          {fmtMs(au.durationMs)} · {au.sentences} 句 · {au.chunks} 块
                        </p>
                      </Link>
                      {!wide && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {au.tags.length === 0 ? (
                            <span className="text-xs text-neutral-400">（无标签）</span>
                          ) : (
                            au.tags.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                              >
                                {t}
                              </span>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                      {/*
                        底部操作行。**编辑按钮只给标题与标签**：音频没有整片描述
                        字段，给了描述框用户填完保存会被服务端拒掉，而拒绝的理由
                        （「视频/音频没有整片描述可改」）对用户是不可操作的信息。
                      */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                        <LibraryEditButton
                          id={au.id}
                          kind="audio"
                          title={au.title}
                          tags={au.tags}
                          annotation=""
                          annotationLabel=""
                        />
                        <LibraryDeleteButton id={au.id} title={au.title} />
                      </div>

                  {wide && au.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {au.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </form>
        )}
        <MoreLink
          keep={keepForCols}
          shown={shown}
          remaining={data.total.audio - data.audio.length}
          unit="条"
        />
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-neutral-300">文本</h2>
          {data.text.length > 0 && (
            <BulkBar
              formId="bulk-text"
              targets={collections}
              currentId={collectionId}
              wide={wide}
              selecting={selecting}
              enterHref={enterSelectHref}
              exitHref={exitSelectHref}
            />
          )}
        </div>
        {data.text.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">
            {kind && kind !== 'text'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的文本`
                : '还没有文本笔记'}
          </p>
        ) : (
          <form id="bulk-text" action="/api/library/bulk/form" method="post">
            <input type="hidden" name="redirect" value={backHref} />
            <ul className={listCls}>
              {data.text.map((t) => (
                <li
                  key={t.id}
                  className={
                    wide
                      ? 'rounded-md border border-neutral-800 bg-neutral-900/60 p-4'
                      : 'flex flex-col rounded-md border border-neutral-800 bg-neutral-900/60 p-2'
                  }
                >
                  <div className={wide ? 'flex items-center gap-3' : 'flex flex-col gap-1.5'}>
                    {selecting && <AssetCheckbox name="text" value={t.id} title={t.title} />}
                    <Link
                      href={`/library/text/${t.id}`}
                      className="min-w-0 flex-1 hover:underline"
                      title="查看与编辑这段文本"
                    >
                      <p className={wide ? 'truncate text-sm text-neutral-200' : 'text-sm leading-5 text-neutral-200 line-clamp-2'}>
                        {t.title}
                      </p>
                      <p className="mt-1 text-xs text-neutral-400">
                        {t.chars} 字 · {lightMode ? '关键词可检索' : t.hasVector ? '可搜索' : '暂不可搜索'}
                        {wide ? ' · 查看与编辑' : ''}
                      </p>
                    </Link>
                    <span className="flex flex-none items-center gap-1.5">
                      <LibraryEditButton
                        id={t.id}
                        kind="text"
                        title={t.title}
                        annotation={t.content ?? ''}
                        annotationLabel="正文"
                        tags={t.tags}
                      />
                      <LibraryDeleteButton id={t.id} title={t.title} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </form>
        )}
        <MoreLink
          keep={keepForCols}
          shown={shown}
          remaining={data.total.text - data.text.length}
          unit="条"
        />
      </section>

      {moved !== null && (
        <p className="mt-6 text-xs text-emerald-400">已移动 {moved} 条素材</p>
      )}
      {copied !== null && (
        <p className="mt-6 text-xs text-emerald-400">
          已复制 {copied} 条素材（文件已在素材目录中复制一份）
        </p>
      )}

      <p className="mt-8 text-xs leading-5 text-neutral-400">
        删除只是把素材移出素材库，文件仍留在素材目录，需要清理请自行处理。
      </p>
    </div>
  )
}
