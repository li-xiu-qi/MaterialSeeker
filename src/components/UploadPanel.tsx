'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'ts']

type Kind = 'image' | 'video'

type Phase =
  | 'waiting' // 已选好，还没轮到
  | 'uploading' // 上传中，有字节进度
  | 'encoding' // 图片编码中（在上传请求内）
  | 'queued' // 已提交，排队等后台执行
  | 'processing' // 后台执行中，stage 是具体阶段
  | 'done'
  | 'error'

interface Row {
  key: string
  name: string
  size: number
  kind: Kind | null
  phase: Phase
  /** 上传字节进度 0-100 */
  upload: number
  /** 该文件整体进度 0-100（上传与处理各占一段） */
  pct: number
  stage: string
  detail: string
  error: string
  jobId: number | null
  /** 本地 blob 地址，仅视频有。用于在上传等待期间预览原片 */
  localUrl?: string
}

interface JobSnapshot {
  id: number
  kind: string
  title: string
  status: string
  stage: string
  percent: number
  message: string
  error: string | null
}

function kindOf(name: string): Kind | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  return null
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/**
 * 阶段中文名。与 ingestRunner 的 stage 表分开维护是故意的：那边的标签是给
 * 日志与接口用的键，这边才是给用户看的字。
 */
const STAGE_LABEL: Record<string, string> = {
  prepare: '检查与准备',
  scenes: '分析画面切换',
  frames: '抽取关键帧',
  audio: '抽取音轨',
  transcribe: '语音转文字',
  'text-encode': '文字向量化',
  db: '写入库',
  'frame-encode': '画面向量化',
}

/**
 * 上传一个文件，用 XMLHttpRequest 而不是 fetch。
 *
 * fetch 拿不到上传字节进度（upload.onprogress 只在 XHR 上），而这一步恰恰是
 * 大视频最让人觉得「卡死」的地方：几百兆走局域网要好几分钟，界面上什么都没有。
 * 有字节数之后，进度条是真实在走的。
 */
function uploadFile(
  file: File,
  collectionId: number,
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  kind?: Kind
  path?: string
  assetId?: number
  error?: string
}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const fd = new FormData()
    fd.append('file', file)
    fd.append('collectionId', String(collectionId))

    xhr.open('POST', '/api/upload')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText))
      } catch {
        reject(new Error('服务端响应无法解析'))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误，上传中断'))
    xhr.onabort = () => reject(new Error('已取消'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(fd)
  })
}

/**
 * 入库面板。**两条路并存：有 JS 走 fetch 拿实时进度，没 JS 走原生表单整页提交。**
 *
 * 之前只有一个半成品：onChange 里调 requestSubmit()，选完文件立刻原生 POST
 * 整页刷新，于是下面那一大套 stage / message / done / log 永远不渲染，进度界面
 * 整体是死代码；而拖放只取 files[0]，拖五个进去只入一个，其余静默丢掉。
 *
 * 现在的分工：
 * - 有 JS：选文件或拖放都进 run()，逐个 fetch，进度与结果都在页面上，不刷新。
 * - 没 JS：onChange / onSubmit 都不存在，原生 form（带 multiple）照常提交，
 *   服务端一次收多个、入库后 redirect 回本页带汇总，结果由服务端渲染。
 *
 * **requestSubmit 只在无 JS 的那条路上有意义**，所以 JS 路上必须 preventDefault，
 * 否则点「开始入库」会同时触发 fetch 与原生提交，同一个文件入两次。
 *
 * 2026-09-23 重写进度部分。原来所有文件共用一个状态条、一个假动画进度
 * （宽度恒为三分之一），视频分钟级期间界面完全不动；且视频入库是同步请求，
 * 上传几十兆的等待没有任何字节反馈。现在：每个文件一行，上传有字节进度，
 * 视频进后台队列逐 stage 报百分比，文件之间能看出谁在跑、谁在等。
 */
export function UploadPanel({
  collections,
  currentCollectionId,
}: {
  collections: Array<{ id: number; name: string }>
  /** 当前选中的目标库，由页面从 URL 的 lib 参数传入 */
  currentCollectionId: number
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [targetId, setTargetId] = useState(currentCollectionId)
  const [rows, setRows] = useState<Row[]>([])
  // 哪一行正在展开本地预览。一次只展开一个：预览区不小，同时开两个会把
  // 整个入库面板顶长，而人一次只看一个视频。
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  // blob 地址登记表。key 与 Row.key 相同，卸载时统一 revoke，不留泄漏。
  const blobUrls = useRef<Map<string, string>>(new Map())
  useEffect(
    () => () => {
      // 卸载时只 revoke，不动 rows：此刻组件已经要没了。
      for (const url of blobUrls.current.values()) URL.revokeObjectURL(url)
      blobUrls.current.clear()
    },
    [],
  )
  // 同一批文件只跑一次。选完文件会自动开始，用户再点按钮时不能再来一遍。
  const runningRef = useRef(false)
  // 批次号。刷新页面后靠它把这一批任务重新查回来，不让进度凭空消失。
  const batchRef = useRef('')
  const batchStartedAt = useRef(0)

  const patch = useCallback((key: string, p: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }, [])

  /** 轮询后台任务状态。只在有视频任务在跑时才发请求。 */
  const hasActiveJob = rows.some((r) => r.phase === 'queued' || r.phase === 'processing')
  useEffect(() => {
    if (!hasActiveJob) return
    let alive = true
    const tick = async () => {
      try {
        // 查全量队列再按 jobId 匹配，而不是按 batch 查：刷新页面后 rows 与
        // batchRef 一起丢了，按 batch 查回来也没有行可对。侧边栏本来就在轮
        // 同一个接口，这里复用同一份数据，不多一次服务端查询口径。
        const r = await fetch('/api/ingest/jobs?queue=1', { cache: 'no-store' })
        const d = (await r.json()) as { ok: boolean; jobs?: JobSnapshot[] }
        if (!alive || !d.ok || !d.jobs) return
        setRows((prev) =>
          prev.map((row) => {
            if (row.jobId == null) return row
            const j = d.jobs!.find((x) => x.id === row.jobId)
            if (!j) return row
            if (j.status === 'done') {
              return {
                ...row,
                phase: 'done',
                pct: 100,
                stage: '完成',
                detail: j.message || '已完成',
                error: '',
              }
            }
            if (j.status === 'error' || j.status === 'canceled') {
              return { ...row, phase: 'error', stage: '失败', error: j.error || j.message || '处理失败' }
            }
            // 服务端的 queued 也是「排队」，不是「处理中」。混成 processing 会把
            // 原始 stage 键（queued）直接显示给用户，界面上出现一个洋文词。
            if (j.status === 'queued') {
              return { ...row, phase: 'queued', pct: Math.max(row.pct, 2), stage: '排队中', detail: '' }
            }
            return {
              ...row,
              phase: 'processing',
              pct: j.percent,
              stage: STAGE_LABEL[j.stage] ?? j.stage,
              detail: j.message || '',
              error: '',
            }
          }),
        )
      } catch {
        // 轮询失败不提示：下一拍还会再来，弹错反而干扰
      }
    }
    void tick()
    const timer = setInterval(tick, 1200)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [hasActiveJob])

  async function run(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : []
    if (list.length === 0 || runningRef.current) return
    runningRef.current = true

    if (!batchRef.current) {
      batchRef.current = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }
    batchStartedAt.current = Date.now()
    const batchId = batchRef.current

    // 本地预览地址。**只对视频建**：图片上传是秒级，没有「等待中想看
    // 内容」这个窗口；视频反之，1.91 GB 走局域网要几分钟，这期间人最想
    // 确认的就是「我没选错文件」。
    //
    // createObjectURL 是零拷贝的，它只是给浏览器内存里那个 File 对象起个
    // 能塞进 src 的名字，1.91 GB 不会被读进内存；播放时浏览器按需读文件。
    const newRows: Row[] = list.map((f, i) => {
      const kind = kindOf(f.name)
      let localUrl: string | undefined
      if (kind === 'video') {
        localUrl = URL.createObjectURL(f)
        blobUrls.current.set(`${batchId}-${i}-${f.name}`, localUrl)
      }
      return {
        key: `${batchId}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
        kind,
        phase: 'waiting',
        upload: 0,
        pct: 0,
        stage: '',
        detail: '',
        error: '',
        jobId: null,
        localUrl,
      }
    })
    setRows((prev) => [...prev, ...newRows])

    // 先把任务在服务端建好，再开始上传。**顺序很重要**：上传是整条链路最长
    // 的一段（1.91 GB 走局域网两分钟以上），若等上传完再建行，侧边栏队列在
    // 那几分钟里是空的，用户会以为任务没挂上。建行状态为 uploading，字节
    // 进度由 handleOne 轮番上报。
    //
    // 顺序即传入顺序，所以 jobIds[i] 与 list[i]、newRows[i] 一一对应。
    let jobIds: number[] = []
    try {
      const r = await fetch('/api/ingest/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId,
          collectionId: targetId,
          items: list.map((f) => ({ name: f.name, kind: kindOf(f.name) ?? undefined })),
        }),
      })
      const d = (await r.json()) as { ok: boolean; jobIds?: number[] }
      if (d.ok && d.jobIds) jobIds = d.jobIds
    } catch {
      // 建行失败不阻断上传：进度只是侧边栏看不见，文件照样能进库。真失败了
      // 由后面每一步各自的错误提示负责。
    }

    // 并发处理。原来是逐个串行，140 张图要等 140 次上传加编码往返，实测
    // 分钟级；改成 4 路并发后同样一批是四分之一时间。视频也一起进池子：
    // 上传本身是 IO，提交任务只是发一条小 JSON，卡住的是后台队列而不是这里。
    const CONCURRENCY = 4
    let cursor = 0
    const worker = async () => {
      while (cursor < newRows.length) {
        const i = cursor++
        await handleOne(list[i], newRows[i], batchId, jobIds[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, newRows.length) }, worker))

    if (inputRef.current) inputRef.current.value = ''
    runningRef.current = false
    router.refresh()
  }

  async function handleOne(file: File, row: Row, batchId: string, jobId?: number) {
    if (!row.kind) {
      patch(row.key, { phase: 'error', error: '不支持的格式', stage: '跳过' })
      return
    }

    patch(row.key, { phase: 'uploading', upload: 0, stage: '上传中', pct: 0, jobId: jobId ?? null })

    let up: Awaited<ReturnType<typeof uploadFile>>
    try {
      up = await uploadFile(file, targetId, (pct) => {
        patch(row.key, { upload: pct })
        // 同步给服务端，侧边栏才有字节进度可显示。节流到每 5% 一发：每帧都
        // 发会把轮询接口之外的请求量翻几倍，而进度条看不出差别。
        if (jobId != null && (pct === 100 || pct % 5 === 0)) {
          void fetch('/api/ingest/jobs', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: jobId, percent: pct }),
          }).catch(() => {
            // 上报失败不影响上传本身，静默跳过
          })
        }
      })
    } catch (e) {
      patch(row.key, {
        phase: 'error',
        error: e instanceof Error ? e.message : String(e),
        stage: '上传失败',
      })
      return
    }

    if (!up.ok || !up.path) {
      patch(row.key, { phase: 'error', error: up.error ?? '上传失败', stage: '上传失败' })
      return
    }

    if (up.kind === 'image') {
      // 图片的上传与编码在同一个请求里完成（秒级）。把服务端那一行推到终态，
      // 否则它会永远停在「上传中」，侧边栏里看着像卡死。
      if (jobId != null) {
        void fetch('/api/ingest/jobs', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: jobId, finish: true }),
        }).catch(() => {})
      }
      patch(row.key, { phase: 'done', upload: 100, pct: 100, stage: '完成', detail: '已入库，可被检索' })
      return
    }

    // 视频：提交后台任务就结束这一行，不在请求里干等处理。带上 jobId，让
    // 服务端复用上传前建好的那一行，而不是另建一行——否则同一个文件在侧边栏
    // 里会先以「上传中」出现一遍、处理时又出现一遍，看着像两个任务。
    patch(row.key, { phase: 'queued', upload: 100, pct: 2, stage: '排队中' })
    try {
      const r = await fetch('/api/ingest/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPath: up.path,
          title: file.name,
          batchId,
          jobId,
          collectionId: targetId,
        }),
      })
      const d = (await r.json()) as { ok: boolean; jobId?: number; error?: string }
      if (!d.ok || !d.jobId) {
        patch(row.key, { phase: 'error', error: d.error ?? '提交失败', stage: '提交失败' })
        return
      }
      patch(row.key, { jobId: d.jobId, phase: 'queued', pct: 2, stage: '排队中' })
    } catch (e) {
      patch(row.key, {
        phase: 'error',
        error: e instanceof Error ? e.message : String(e),
        stage: '提交失败',
      })
    }
  }

  const busy = rows.some((r) =>
    ['waiting', 'uploading', 'encoding', 'queued', 'processing'].includes(r.phase),
  )
  const doneCount = rows.filter((r) => r.phase === 'done').length
  const errorCount = rows.filter((r) => r.phase === 'error').length
  const overall = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length) : 0
  const activeName = rows.find((r) => r.phase === 'uploading' || r.phase === 'processing')?.name

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-neutral-200">入库</h2>
        <p className="text-[11px] text-neutral-600">图片即传即入库，视频转入写与抽帧后入库</p>
      </div>

      {/* 目标库。多库之后入库必须能选归属，否则建了库也只能进默认库，
          检索作用域就形同虚设。 */}
      <div className="mt-3 flex items-center gap-2">
        <label htmlFor="ingest-collection" className="text-[11px] text-neutral-500">
          入库到
        </label>
        <select
          id="ingest-collection"
          value={targetId}
          onChange={(e) => setTargetId(Number(e.target.value))}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 outline-none focus:border-neutral-500"
        >
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/*
        原生 form 是无 JS 时的退路，**必须带 multiple**：不然一次只能选一个文件，
        选十张图要提交十次整页刷新。有 JS 时 onSubmit 会 preventDefault 并改走
        fetch，两条路共用同一个表单。
      */}
      <form
        action="/api/ingest/form"
        method="post"
        encType="multipart/form-data"
        onSubmit={(e) => {
          // 有 JS 就走 fetch 那条路，原生提交会让同一个文件入两次
          e.preventDefault()
          void run(inputRef.current?.files ?? null)
        }}
      >
        <input type="hidden" name="collectionId" value={targetId} />

        {/*
          用 label 包住文件输入，而不是 div 上挂 onClick 调 input.click()。
          label 关联的文件输入被点击时浏览器原生打开对话框，这条路不依赖 JS；
          此前那种写法在客户端 JS 不执行时点它毫无反应（用户实测踩到过）。
          multiple 让一次能选多个，无 JS 的原生提交也吃得住。
        */}
        <label
          className="mt-3 block cursor-pointer rounded-md border border-dashed border-neutral-700 p-6 text-center transition hover:border-neutral-500 hover:bg-neutral-800/30"
          onDragOver={(e) => {
            // 必须 preventDefault，否则浏览器默认动作是直接在窗口里打开文件
            e.preventDefault()
          }}
          onDrop={(e) => {
            e.preventDefault()
            // 收全部拖进来的文件，不是 files[0]。之前只取第一个，拖五个进一个，
            // 其余连提示都没有。DataTransfer 也不需要了：直接交给 run()。
            void run(e.dataTransfer.files)
          }}
        >
          <p className="text-sm text-neutral-400">点击选择，或把文件拖到这里</p>
          <p className="mt-1 text-xs text-neutral-600">
            图片（{IMAGE_EXTS.join(' / ')}）· 视频（{VIDEO_EXTS.join(' / ')}）
          </p>
          <p className="mt-1 text-xs text-neutral-600">可一次选多个，视频会慢一些</p>
          <input
            ref={inputRef}
            name="file"
            type="file"
            multiple
            accept={[...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',')}
            className="hidden"
            onChange={(e) => {
              // 选完即开始，不用再点按钮。无 JS 时这个 handler 不存在，改由
              // 「开始入库」做原生提交，服务端一次收多个。
              if (e.target.files?.length) void run(e.target.files)
            }}
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="mt-3 w-full rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {busy ? '处理中…' : '开始入库'}
        </button>
      </form>

      {rows.length > 0 && (
        <div className="mt-4 border-t border-neutral-800 pt-3">
          {/* 总览。视频是分钟级，明确告诉用户没卡死、还要等多久 */}
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-neutral-300">
              {doneCount}/{rows.length} 已完成
              {errorCount > 0 && <span className="text-red-400"> · {errorCount} 个失败</span>}
            </span>
            {busy && (
              <span className="text-neutral-500">
                已用 {fmtElapsed(Date.now() - batchStartedAt.current)}
                {activeName ? ` · 正在处理 ${activeName}` : ''}
              </span>
            )}
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-neutral-200 transition-[width] duration-500"
              style={{ width: `${overall}%` }}
            />
          </div>

          <ul className="mt-3 space-y-2">
            {rows.map((r) => (
              <li key={r.key} className="rounded-md border border-neutral-800 bg-neutral-950/50 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex-none rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                    {r.kind === 'image' ? '图片' : r.kind === 'video' ? '视频' : '文件'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={r.name}>
                    {r.name}
                  </span>
                  <span className="flex-none text-[10px] text-neutral-600">{fmtSize(r.size)}</span>
                  <PhaseTag phase={r.phase} stage={r.stage} pct={r.pct} />
                  {/*
                    本地预览。**放在等待中就能点**，这是它唯一有意义的地方：
                    上传 1.91 GB 要几分钟，那几分钟里服务端磁盘上什么都没有
                    （req.formData() 要等请求体读完才返回），不可能播服务端的
                    文件。播的是浏览器自己选中的那个 File，零网络、即时响应。
                    入库完成后仍可点，用来核对「我传上去的是这一条」。
                  */}
                  {r.localUrl && (
                    <button
                      type="button"
                      onClick={() => setPreviewKey((k) => (k === r.key ? null : r.key))}
                      className="flex-none rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                    >
                      {previewKey === r.key ? '收起' : '预览'}
                    </button>
                  )}
                </div>

                {/* 单文件进度条。上传段与处理段用同一条，宽度由 pct 统一驱动 */}
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-neutral-800">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${
                      r.phase === 'error'
                        ? 'bg-red-500'
                        : r.phase === 'done'
                          ? 'bg-emerald-500'
                          : 'bg-neutral-300'
                    }`}
                    style={{ width: `${r.pct}%` }}
                  />
                </div>

                <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                  <span className="min-w-0 flex-1 truncate text-neutral-500">
                    {r.phase === 'uploading'
                      ? `上传中 ${r.upload}%`
                      : r.detail
                        ? r.detail
                        : r.stage
                          ? r.stage
                          : '等待中'}
                  </span>
                  {r.error && <span className="flex-none text-red-400">{r.error}</span>}
                </div>

                {/*
                  外层套一个 16:9 容器。**不是为了好看，是为了高度不塌**：
                  <video> 在拿到 metadata 之前高度是浏览器默认的约 150px，
                  加载慢或加载失败时那一行就会突然变矮。套上 aspect-video
                  后等待期间也是一个正常的黑框。

                  preload="metadata"：只读文件头拿时长与尺寸，不预载整段。
                  本地文件也必须这样，1.91 GB 全预载会把内存和磁盘一起打满。
                */}
                {previewKey === r.key && r.localUrl && (
                  <div className="mt-2 aspect-video w-full overflow-hidden rounded border border-neutral-800 bg-black">
                    <video
                      src={r.localUrl}
                      controls
                      preload="metadata"
                      playsInline
                      className="h-full w-full"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>

          {!busy && doneCount > 0 && (
            <Link
              href={`/?lib=${targetId}`}
              className="mt-3 inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
            >
              去检索这个库
            </Link>
          )}
        </div>
      )}
    </section>
  )
}

function PhaseTag({ phase, stage, pct }: { phase: Phase; stage: string; pct: number }) {
  const tone =
    phase === 'error'
      ? 'text-red-400'
      : phase === 'done'
        ? 'text-emerald-400'
        : phase === 'waiting'
          ? 'text-neutral-600'
          : 'text-neutral-300'
  const text =
    phase === 'waiting'
      ? '等待'
      : phase === 'uploading'
        ? '上传'
        : phase === 'encoding'
          ? '编码'
          : phase === 'queued'
            ? '排队'
            : phase === 'processing'
              ? stage || '处理'
              : phase === 'done'
                ? '完成'
                : '失败'
  return (
    <span className={`flex-none text-[10px] ${tone}`}>
      {text}
      {(phase === 'processing' || phase === 'queued') && pct > 0 ? ` ${pct}%` : ''}
    </span>
  )
}
