/**
 * 文本入库。**原生表单，不依赖 JS**，跟图片视频那条 multipart 路一个性质：
 * 填完点提交，服务端入库后 redirect 回入库页带结果。
 *
 * 单独一个组件而不是塞进 UploadPanel：那边是「选文件」的形态（点击、拖放、
 * 多选、进度条），文本没有文件，两种输入心智混在同一块区域会互相干扰。
 * 分成两张卡各管一种，用户一眼看出这块是填字的。
 */
export function TextIngestForm({ currentCollectionId }: { currentCollectionId: number }) {
  return (
    <section className="panel mt-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-200">入库文本</h2>
        <p className="text-xs text-neutral-400">笔记、文案、台词，填进去就能被检索</p>
      </div>

      <form action="/api/ingest/text/form" method="post" className="mt-3 space-y-3" data-tour="ingest-text">
        <input type="hidden" name="collectionId" value={currentCollectionId} />

        <div>
          <label htmlFor="text-title" className="block text-xs text-neutral-400">
            标题
          </label>
          <input
            id="text-title"
            name="title"
            maxLength={120}
            required
            placeholder="例如：开场台词备选"
            className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-500"
          />
        </div>

        <div>
          <label htmlFor="text-content" className="block text-xs text-neutral-400">
            内容
          </label>
          <textarea
            id="text-content"
            name="content"
            required
            rows={6}
            placeholder="把要检索的正文粘进来"
            className="mt-1 w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm leading-6 outline-none focus:border-neutral-500"
          />
        </div>

        <button
          type="submit"
          className="btn-primary w-full"
        >
          保存这段文本
        </button>
      </form>
    </section>
  )
}
