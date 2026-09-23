import Link from 'next/link'
import { TextIngestForm } from '@/components/TextIngestForm'
import { UploadPanel } from '@/components/UploadPanel'
import { QueuePanel } from '@/components/QueuePanel'
import { listCollections, normalizeCollectionId, getCollection } from '@/lib/collections'

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
    count?: string
    imgs?: string
    vids?: string
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
    count,
    imgs,
    vids,
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

  const imgN = Number(imgs) || 0
  const vidN = Number(vids) || 0
  const failN = Number(fail) || 0
  const total = Number(count) || imgN + vidN

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold">入库</h1>
      <p className="mt-1 text-sm text-neutral-400">
        当前入库到「{current ? current.name : '默认库'}」，切换库请在上方选择
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
            {name ? `：${name}` : ''}
          </p>
          {failN > 0 && (
            <p className="mt-1 text-[11px] text-amber-300/80">
              有 {failN} 个没进去{failDetail ? `：${failDetail}` : ''}。文件若已落到素材目录，
              可以重新选它再试。
            </p>
          )}
          <Link href={`/?lib=${currentId}`} className="mt-1 inline-block text-[11px] underline">
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
          <Link href={`/?lib=${currentId}`} className="mt-1 inline-block text-[11px] underline">
            去检索这个库
          </Link>
        </div>
      )}

      {/*
        **两栏，任务队列在右而不是全局导航。** 它属于入库页的上下文：真正的等待
        发生在这一页，左边上传面板就是实时进度；右栏补的是左栏给不了的，即刷新后
        仍在、其他标签页发起的任务。它曾挂在全局导航侧边栏，被指出层级错了——
        一块与导航无关的内容常驻在那里，每次打开应用都看得见，而它对检索页与素材库
        页毫无意义。

        窄屏（<lg）右侧栏整体隐藏，不堆到上传面板下面：等待期间人看的是左栏那一批，
        右栏在这时只是补充，真需要时把窗口拉宽即可，它不是主路径。

        错误提示与入库汇总刻意留在这两栏之外：它们是这一批操作的结论，与「哪些任务
        还在跑」不是一回事，塞进左栏会让人以为它属于上传面板。
      */}
      <div className="mt-6 flex items-start gap-8">
        <div className="min-w-0 flex-1">
          <UploadPanel
          collections={collections.map((c) => ({ id: c.id, name: c.name }))}
          currentCollectionId={currentId}
        />

      {/*
        文本入库单独一张卡。**不是塞进上面那个上传面板里**：那边是「选文件」
        的形态（点击、拖放、多选），文本没有文件，混在一起会让两种心智模型
        挤在同一块区域。分成两张卡，各管一种输入形态。
        原生表单提交，跟图片视频一样不依赖 JS。
      */}
          <TextIngestForm
            collections={collections.map((c) => ({ id: c.id, name: c.name }))}
            currentCollectionId={currentId}
          />
        </div>

        <aside className="hidden w-64 flex-none lg:block">
          {/*
            sticky 跟着滚：任务要跑几分钟，这一页会长，队列停在视野里才对。
            top-10 对齐主区的 py-10，不贴顶。
          */}
          <div className="sticky top-10">
            <QueuePanel />
          </div>
        </aside>
      </div>
    </div>
  )
}
