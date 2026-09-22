import Link from 'next/link'

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'text', label: '文本' },
] as const

/**
 * 列表栏数。**走 URL 参数，不用客户端 state。**
 *
 * 这个页面所有控件都不依赖 JS，栏数切换也没理由依赖：换栏就是一个链接，点完
 * 整页重出。用 state 的话，hydration 不生效时按钮还在但点了没反应，而列表本身
 * 是只读的。
 *
 * `img` 分页参数要跟着一起带：栏数变了单屏能放的条数就变了，但已加载的条数
 * 不该因此丢，否则从四栏切回单栏时刚显示的图又缩回 24 张。
 */
const COL_OPTIONS = [
  { value: '1', label: '单栏' },
  { value: '2', label: '双栏' },
  { value: '4', label: '四栏' },
] as const

const parseCols = (c: string | undefined): 1 | 2 | 4 =>
  c === '2' ? 2 : c === '4' ? 4 : 1

/**
 * 栏数对应的列表容器类。**必须是字面量，不能用 `grid-cols-${cols}` 拼。**
 *
 * Tailwind 按源码里出现过的字面类名生成 CSS，模板字符串拼出来的类名在构建时
 * 不存在，扫不到就不会生成，结果是双栏四栏看着没生效、控制台也不报错。这类坑
 * 靠「改完看一眼」发现不了，因为单栏本来就没用到这几个类。
 *
 * 单栏保持 space-y-3 的竖排间距；多栏用 grid，卡片高度不一时由 grid 自动对齐。
 */
const LIST_CLS: Record<1 | 2 | 4, string> = {
  1: 'mt-3 space-y-3',
  2: 'mt-3 grid grid-cols-2 gap-3',
  4: 'mt-3 grid grid-cols-4 gap-3',
}

/**
 * 缩略图按栏数分级请求尺寸。缩略图不是请求越大越清晰，是「源图够铺满显示区域
 * 就行」：二栏卡片内容宽约 409px，仍按单栏的 192px 请求会被拉成 2.2 倍放大，
 * 肉眼可见地糊；四栏约 199px，192px 刚好不放大。所以一栏给 192（显示只有 128px），
 * 二栏给 640，四栏给 384。
 *
 * 同样是字面量常量，理由同 LIST_CLS：构建时要能扫到具体值。
 */
const THUMB_W: Record<1 | 2 | 4, number> = {
  1: 192,
  2: 640,
  4: 384,
}
const COVER_W: Record<1 | 2 | 4, number> = {
  1: 256,
  2: 640,
  4: 384,
}

import { getLibraryList, filterLibraryList } from '@/lib/library'
import { toMediaUrl, toThumbUrl } from '@/lib/media'
import { LibraryDeleteButton } from '@/components/LibraryDeleteButton'
import { LibraryEditButton } from '@/components/LibraryEditButton'
import { CollectionScope } from '@/components/CollectionScope'
import { CollectionMenu } from '@/components/CollectionMenu'
import { BulkDeleteButton } from '@/components/BulkDeleteButton'
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
 * 分页走 URL 参数 ?img=<已显示条数>，不用客户端 state，同样是为了不依赖 JS。
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
}) {
  const btn =
    'rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200'
  if (!selecting) {
    return (
      <Link
        href={enterHref}
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
      >
        多选
      </Link>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        name="to"
        form={formId}
        defaultValue=""
        aria-label="目标素材库"
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 outline-none focus:border-neutral-500"
      >
        <option value="">选择目标库</option>
        {targets.map((t) => (
          <option key={t.id} value={t.id} disabled={t.id === currentId}>
            {t.name}
            {t.id === currentId ? '（当前）' : ''}
          </option>
        ))}
      </select>
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
      <button
        type="submit"
        form={formId}
        formAction="/api/library/bulk/form"
        formMethod="post"
        className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-700 hover:text-red-300"
      >
        删除所选
      </button>
      <Link href={exitHref} className={btn}>
        完成
      </Link>
      <span className="text-[11px] text-neutral-700">
        {wide ? '勾选左侧方框' : '勾选卡片左上角'}
      </span>
    </div>
  )
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{
    img?: string
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
    img,
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
  const shown = Math.max(PAGE, Math.min(Number(img) || PAGE, 400))
  // 类型与关键词筛选。关键词按标题与画面描述做子串匹配，理由见
  // filterLibraryList 的注释：中文不走 FTS，那条路默认 tokenizer 不分词。
  const kind = k === 'video' || k === 'image' || k === 'text' ? k : undefined
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
  const data = filterLibraryList(getLibraryList(collectionId), { kind, q: keyword })
  const images = data.image.slice(0, shown)
  const rest = data.image.length - images.length
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
    )}&c=${cols}${shown > PAGE ? `&img=${shown}` : ''}`,
  )
  /** 栏数切换时要一并带上的参数：丢了 img 会把已加载的图缩回首页 */
  const keepForCols = new URLSearchParams({
    lib: libQ,
    k: kind ?? 'all',
    kw: keyword,
    ...(shown > PAGE ? { img: String(shown) } : {}),
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

      {cerr && <p className="mt-2 text-[11px] text-red-400">{cerr}</p>}
      {deletedName && (
        <p className="mt-2 text-[11px] text-emerald-400">已删除素材库「{deletedName}」</p>
      )}
      {bulkRemoved && (
        <p className="mt-2 text-[11px] text-emerald-400">
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
          assetCount={data.counts.video + data.counts.image + data.counts.text}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
        <span>视频 {data.counts.video}</span>
        <span>图片 {data.counts.image}</span>
        <span>文本 {data.counts.text}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-neutral-600">栏数</span>
          {COL_OPTIONS.map((o) => {
            const active = cols === Number(o.value)
            const href = new URLSearchParams(keepForCols)
            href.set('c', o.value)
            return (
              <Link
                key={o.value}
                href={withSelect(`/library?${href.toString()}`)}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
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
          <span className="text-neutral-600">类型</span>
          {FILTERS.map((f) => {
            const active = (kind ?? 'all') === f.value
            return (
              <Link
                key={f.value}
                href={withSelect(
                  `/library?lib=${libQ}&k=${f.value}&kw=${encodeURIComponent(keyword)}`,
                )}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
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
          placeholder="按标题或画面描述过滤"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs outline-none focus:border-neutral-500"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-300 hover:border-neutral-500"
        >
          过滤
        </button>
        {keyword && (
          <Link
            href={`/library?lib=${libQ}&k=${kind ?? 'all'}`}
            className="self-center text-[11px] text-neutral-600 underline hover:text-neutral-300"
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
          <p className="mt-3 text-xs text-neutral-700">
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
                        <span className="mt-1 block text-[11px] text-neutral-600">
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
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-neutral-300">图片</h2>
          {images.length > 0 && (
            <BulkBar
              formId="bulk-image"
              targets={collections}
              currentId={collectionId}
              wide={wide}
              selecting={selecting}
              enterHref={enterSelectHref}
              exitHref={exitSelectHref}
            />
          )}
        </div>
        {images.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-700">
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
              {images.map((im) => {
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
                              ? 'mt-1 block text-[11px] text-neutral-400'
                              : 'mt-0.5 block text-[11px] leading-4 text-neutral-400 line-clamp-2'
                          }
                        >
                          {im.caption ?? '（无说明）'}
                        </span>
                        <span className="mt-1 block text-[11px] text-neutral-600">
                          {im.hasVector ? '可检索' : '暂不可检索'}
                          {im.hasCaptionVector && wide ? ' · 可按描述搜索' : ''}
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
        {rest > 0 && (
          <Link
            href={`/library?lib=${libQ}&k=${kind ?? 'all'}&kw=${encodeURIComponent(
              keyword,
            )}&c=${cols}&img=${shown + PAGE}`}
            className="mt-3 block w-full rounded-md border border-neutral-800 px-3 py-2 text-center text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          >
            显示更多（还有 {rest} 张）
          </Link>
        )}
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
          <p className="mt-3 text-xs text-neutral-700">
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
                      <p className="mt-1 text-[11px] text-neutral-600">
                        {t.chars} 字 · {t.hasVector ? '可检索' : '暂不可检索'}
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
                      />
                      <LibraryDeleteButton id={t.id} title={t.title} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </form>
        )}
      </section>

      {moved !== null && (
        <p className="mt-6 text-[11px] text-emerald-400">已移动 {moved} 条素材</p>
      )}
      {copied !== null && (
        <p className="mt-6 text-[11px] text-emerald-400">
          已复制 {copied} 条素材（文件已在素材目录中复制一份）
        </p>
      )}

      <p className="mt-8 text-[11px] leading-5 text-neutral-700">
        删除只是把素材移出素材库，文件仍留在素材目录，需要清理请自行处理。
      </p>
    </div>
  )
}
