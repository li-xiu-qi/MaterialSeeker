import Link from 'next/link'

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'video', label: '视频' },
  { value: 'image', label: '图片' },
  { value: 'text', label: '文本' },
] as const
import { getLibraryList, filterLibraryList } from '@/lib/library'
import { toMediaUrl, toThumbUrl } from '@/lib/media'
import { LibraryDeleteButton } from '@/components/LibraryDeleteButton'
import { CollectionScope } from '@/components/CollectionScope'
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

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ img?: string; lib?: string; k?: string; kw?: string; made?: string; cerr?: string }>
}) {
  const { img, lib, k, kw, made, cerr } = await searchParams
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
  // 拼进 URL 时必须把全部态写成 all。直接拼数字 0 的话，normalizeCollectionId
  // 会把 0 当非法值回落成默认库，结果是「选了全部库，一过滤就悄悄回到默认库」
  // 且没有任何提示。
  const libQ = collectionId === ALL_COLLECTIONS ? 'all' : String(collectionId)
  const data = filterLibraryList(getLibraryList(collectionId), { kind, q: keyword })
  const images = data.image.slice(0, shown)
  const rest = data.image.length - images.length

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-semibold">素材库</h1>
      <p className="mt-1 text-sm text-neutral-400">
        当前范围：{scopeLabel(collectionId)}
        {data.allCollections ? ' · 每条素材标注了所属库' : ''}
      </p>

      {cerr && <p className="mt-2 text-[11px] text-red-400">新建素材库失败：{cerr}</p>}
      <div className="mt-3">
        <CollectionScope
          collections={collections}
          currentId={collectionId}
          label="当前库"
          preserve={{ k: kind ?? 'all', kw: keyword }}
          justMadeId={madeId}
          justMadeName={madeName}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-500">
        <span>视频 {data.counts.video}</span>
        <span>图片 {data.counts.image}</span>
        <span>文本 {data.counts.text}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="text-neutral-600">类型</span>
          {FILTERS.map((f) => {
            const active = (kind ?? 'all') === f.value
            return (
              <Link
                key={f.value}
                href={`/library?lib=${libQ}&k=${f.value}&kw=${encodeURIComponent(keyword)}`}
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
        <h2 className="text-sm font-medium text-neutral-300">视频</h2>
        {data.video.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-700">
            {kind && kind !== 'video'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的视频`
                : '还没有视频素材'}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.video.map((v) => {
              const cover = toThumbUrl(v.cover, 320)
              return (
                <li
                  key={v.id}
                  className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4"
                >
                  <div className="flex items-start gap-3">
                    <Link
                      href={`/library/video/${v.id}`}
                      className="flex min-w-0 flex-1 items-start gap-3"
                    >
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={cover}
                          alt=""
                          className="h-20 w-36 flex-none rounded border border-neutral-800 object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-20 w-36 flex-none rounded border border-neutral-800 bg-neutral-800" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-neutral-200">{v.title}</span>
                        <span className="mt-1 block text-[11px] text-neutral-600">
                          {v.sentences} 句 · {v.chunks} 块 · {v.frames} 帧 · 查看逐字稿与关键帧
                        </span>
                      </span>
                    </Link>
                    <LibraryDeleteButton id={v.id} title={v.title} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-300">图片</h2>
        {images.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-700">
            {kind && kind !== 'image'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的图片`
                : '还没有图片素材'}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {images.map((im) => {
              const thumb = toThumbUrl(im.mediaPath, 192)
              return (
                <li
                  key={im.id}
                  className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4"
                >
                  <div className="flex items-start gap-3">
                    <Link
                      href={`/library/image/${im.id}`}
                      className="flex min-w-0 flex-1 items-start gap-3"
                    >
                      {thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={thumb}
                          alt={im.caption ?? ''}
                          className="h-24 w-32 flex-none rounded border border-neutral-800 object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-24 w-32 flex-none rounded border border-neutral-800 bg-neutral-800" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-neutral-200">{im.title}</span>
                        <span className="mt-1 block text-[11px] text-neutral-400">
                          {im.caption ?? '（无说明）'}
                        </span>
                        <span className="mt-1 block text-[11px] text-neutral-600">
                          向量 {im.hasVector ? '就绪' : '缺失'}
                          {im.hasCaptionVector ? ' · 说明向量就绪' : ''} · 查看大图与相似素材
                        </span>
                      </span>
                    </Link>
                    <LibraryDeleteButton id={im.id} title={im.title} />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {rest > 0 && (
          <Link
            href={`/library?lib=${libQ}&k=${kind ?? 'all'}&kw=${encodeURIComponent(keyword)}&img=${shown + PAGE}`}
            className="mt-3 block w-full rounded-md border border-neutral-800 px-3 py-2 text-center text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
          >
            显示更多（还有 {rest} 张）
          </Link>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-300">文本</h2>
        {data.text.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-700">
            {kind && kind !== 'text'
              ? '已被类型筛选排除'
              : keyword
                ? `没有匹配「${keyword}」的文本`
                : '还没有文本笔记'}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.text.map((t) => (
              <li key={t.id} className="rounded-md border border-neutral-800 bg-neutral-900/60 p-4">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-neutral-200">{t.title}</p>
                    <p className="mt-1 text-[11px] text-neutral-600">
                      {t.chars} 字 · 向量 {t.hasVector ? '就绪' : '缺失'}
                    </p>
                  </div>
                  <LibraryDeleteButton id={t.id} title={t.title} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 text-[11px] leading-5 text-neutral-700">
        删除只摘掉检索索引，源文件保留在素材目录，需要清理请自行处理。
      </p>
    </div>
  )
}
