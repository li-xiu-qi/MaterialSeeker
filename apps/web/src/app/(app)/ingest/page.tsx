import Link from 'next/link'
import { TextIngestForm } from '@/components/TextIngestForm'
import { UploadPanel } from '@/components/UploadPanel'
import { listCollections, normalizeCollectionId, getCollection } from '@/lib/collections'
import { ASSET_KINDS } from '@/lib/mediaKind'
import type { AssetKind } from '@/lib/mediaKind'

/** 有文件的三种模态。文本没有文件，不进这个循环，见下面 JSX 的注释。 */
const FILE_KINDS = ['video', 'image', 'audio'] as const

export const dynamic = 'force-dynamic'

/**
 * 入库页。**独立页面，不再挤在检索页里。**
 *
 * 拆出来的理由：入库与检索是两种不同节奏的事。检索是「想想搜什么」然后看结果，
 * 入库是「选一批文件然后等它处理完」，视频入库要几分钟。混在一页时，入库面板
 * 常驻占着首屏，检索结果反而被推到下面；而且视频处理期间页面一直是处理态，
 * 想顺手搜点什么就得等。分成两页各管一件事。
 *
 * 目标库从 URL 的 lib 参数来。**整条入库链路不依赖客户端 JS**：有 JS 时
 * UploadPanel 走 fetch，逐个文件报进度；没 JS 时原生表单（带 multiple）整页
 * 提交，服务端一次收多个，入库后 redirect 回本页并带上 count/imgs/vids/fail
 * 等汇总参数，由本页服务端渲染。JS 只是让进度更细、页面不刷新。
 */
export default async function IngestPage({
  searchParams,
}: {
  searchParams: Promise<{
    lib?: string
    k?: string
    count?: string
    imgs?: string
    vids?: string
    auds?: string
    fail?: string
    failDetail?: string
    name?: string
    err?: string
    textOk?: string
    textTitle?: string
    textId?: string
    chars?: string
  }>
}) {
  const {
    lib,
    k,
    count,
    imgs,
    vids,
    auds,
    fail,
    failDetail,
    name,
    err,
    textOk,
    textTitle,
    textId,
    chars,
  } = await searchParams
  const collections = listCollections()
  const currentId = normalizeCollectionId(lib)
  const current = getCollection(currentId)

  /**
   * 当前选中的模态。**顺序与 ASSET_KINDS 一致**（视频、图片、音频、文本），
   * 全程只此一份顺序，不让页面自己另排。
   *
   * 非法值按图片兜底而不是报错：?k= 是 URL，用户手打错一个字不该看到一页错误，
   * 落到一个能用的界面上更好。
   */
  const INGEST_TABS = ASSET_KINDS.map((a) => ({ kind: a.kind, label: a.label }))
  const wantedKind = (k ?? '').trim()
  const currentKind: AssetKind = INGEST_TABS.some((t) => t.kind === wantedKind)
    ? (wantedKind as AssetKind)
    : 'image'

  const imgN = Number(imgs) || 0
  const vidN = Number(vids) || 0
  const audN = Number(auds) || 0
  const failN = Number(fail) || 0
  const total = Number(count) || imgN + vidN + audN

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">入库{currentKind !== 'text' ? '' : ''}</h1>
      <p className="mt-1 text-sm text-neutral-400">
        当前入库到「{current ? current.name : '默认库'}」
      </p>

      {err && (
        <p className="mt-4 rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          入库失败：{err}
        </p>
      )}

      {total > 0 && (
        <div
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            failN > 0
              ? 'border-amber-800 bg-amber-950/40 text-amber-200'
              : 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
          }`}
        >
          <p>
            已入库 {total} 个文件
            {imgN > 0 && ` · 图片 ${imgN}`}
            {vidN > 0 && ` · 视频 ${vidN}`}
            {audN > 0 && ` · 音频 ${audN}`}
            {name ? `：${name}` : ''}
          </p>
          {failN > 0 && (
            <p className="mt-1 text-xs text-amber-300/80">
              有 {failN} 个没进去{failDetail ? `：${failDetail}` : ''}。文件若已落到素材目录，
              可以重新选它再试。
            </p>
          )}
          <Link href={`/?lib=${currentId}`} className="mt-1 inline-block text-xs underline">
            去检索这个库
          </Link>
        </div>
      )}

      {textOk && (
        <div className="mt-4 rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
          <p>
            文本「{textTitle}」已入库（#{textId}）
            {chars ? ` · ${chars} 字` : ''}
          </p>
          <Link href={`/?lib=${currentId}`} className="mt-1 inline-block text-xs underline">
            去检索这个库
          </Link>
        </div>
      )}

      {/*
        **三个层级，从上往下：标题 → 横排四个模态 → 单栏主区。**

        四个模态是**这一页的分类导航**，所以横着排在标题正下方，跟「入库」这个
        标题是一组。主区是单栏，不再分左右。

        早先这里有两版都错了。第一版把四个模态竖排塞进右侧栏，与任务队列并列，
        用户指出层级反了：那四个选项是「这一轮要往库里放什么」，是页面自己的分类；
        队列是「什么正在跑」，是执行状态，两者不同级。第二版按这个意见改成模态横排、
        右栏专放队列，但右栏本身的问题还在——它与左栏上传面板显示的是同一批任务，
        只是口径不同（左栏只认这一次选的，右栏认服务端全量），于是要靠一句「这里
        的任务与左边那批文件是同一个来源」来解释，用户直说这部分逻辑混乱。

        第三版把右栏整个去掉，它唯一独有的价值（刷新页面后任务还在）并进左栏：
        面板挂载时从服务端把未完成的任务恢复成行。于是一处显示、刷新不丢，
        256px 宽度还给上传区，也没有第二套口径要解释。

        为什么一种模态一个界面，不再共用一个拖放框：图片是秒级，视频与音频是
        分钟级（转写），共用一个框时无从判断手上的文件要等多久。在标着「图片」
        的地方拖进 mp4 然后等五分钟，比一开始就分开放更让人困惑。分开之后每块
        界面顶部那句话可以直接说清自己的等待量级。

        **选中态进 URL（?k=audio）**：刷新与分享链接落在同一个模态上，且无 JS
        时这四个选项是普通链接，照样能切。
      */}
      <nav className="mt-6" aria-label="入库类型">
        <ul className="flex flex-wrap gap-2">
          {INGEST_TABS.map((tab) => {
            const active = tab.kind === currentKind
            return (
              <li key={tab.kind}>
                <Link
                  href={`/ingest?lib=${currentId}&k=${tab.kind}`}
                  aria-current={active ? 'page' : undefined}
                  className={`block rounded-md px-4 py-2 text-sm transition ${
                    active
                      ? 'bg-neutral-100 font-medium text-neutral-900'
                      : 'border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-100'
                  }`}
                >
                  {tab.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="mt-5">
        {/*
          三种有文件的模态**全部常驻挂载，用 hidden 切显示**，不是渲染当前那一个。

          切模态会把面板卸载重挂，代价是待命区里选好的文件连同步略图一起消失：
          人往图片入口拖了三十张，发现还得补一段音频，点过去再点回来，三十张要
          重选一遍。常驻之后待命文件、本地预览地址、上传进度都留在原处。

          隐藏两块同时挂着的代价是三个面板各自轮询，但轮询条件是自己有没有在
          跑的任务（见 UploadPanel 的 hasActiveJob），没有任务的隐藏面板不发
          请求。真正在后台跑的视频与音频任务也因此不会因为切走了页面而停止，
          这正是想要的行为。

          hidden 属性顺带把隐藏面板从 Tab 顺序里摘掉，键盘用户不会连续 Tab 到
          三个看不见的界面里去。
        */}
        {FILE_KINDS.map((kind) => (
          <div key={kind} hidden={kind !== currentKind}>
            <UploadPanel
              collections={collections.map((c) => ({ id: c.id, name: c.name }))}
              currentCollectionId={currentId}
              accept={kind}
            />
          </div>
        ))}

        {/*
          文本没有文件，也就没有「待命区」这种跨模态要保住的状态，跟着模态显隐
          即可。它单独一张卡：那边是「填标题粘正文」的形态，塞进拖放面板会让
          两种心智模型挤在同一块区域。
        */}
        <div hidden={currentKind !== 'text'}>
          <TextIngestForm
            collections={collections.map((c) => ({ id: c.id, name: c.name }))}
            currentCollectionId={currentId}
          />
        </div>
    </div>
  </div>
)
}

