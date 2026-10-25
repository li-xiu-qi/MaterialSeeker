'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { MediaPreviewModal } from './MediaPreviewModal'
import { AssetEditModal } from './AssetEditModal'
import { KINDS_BY_EXT, kindOfExt, ASSET_KINDS } from '@/lib/mediaKind'
import type { AssetKind } from '@/lib/mediaKind'
import {
  feedCaptionStream,
  shouldClearSelectionAfterRun,
  summarizeCaptionRun,
  type CaptionFailure,
} from '@/lib/captionStream'

/**
 * 本面板只收哪一种模态。**一个面板一种模态**，不是「什么都能拖进来」。
 *
 * 早先图片与视频共用一个拖放框，两条后果：用户拖进一个 mp4 时不知道它会走
 * 分钟级的抽帧加转写，而在一个标着「图片」的地方拖进去就 expect 秒级完成；
 * 反过来拖进图片也会被同一套 video 分支的逻辑绕一圈。现在四种模态各有一个
 * 入口（见入库页的四个选项），进来的是什么就是什么。
 */
type Kind = AssetKind

/**
 * accept 属性用的扩展名表，从全库唯一一份映射里取。
 *
 * **KINDS_BY_EXT 里的扩展名自带前导点**（'.jpg'），所以这里不能再拼一个点。
 * 早先写成 `.${e}`，产出 `..jpg,..jpeg`——不是合法的 MIME 也不是合法的扩展名，
 * 浏览器把整个 accept 当无效值忽略，文件对话框于是什么文件都列。后果正是
 * mediaKind 的注释警告过的那个分裂：面板写着「图片」，用户选得进 mp4，
 * 然后在服务端 400，或者更糟——视频入口收下一个 mp3，转写服务 zero 句。
 */
const ACCEPT_BY_KIND: Record<Kind, string> = {
  image: [...KINDS_BY_EXT.IMAGE_EXTS].join(','),
  video: [...KINDS_BY_EXT.VIDEO_EXTS].join(','),
  audio: [...KINDS_BY_EXT.AUDIO_EXTS].join(','),
  text: '',
}

/** 面板右上角那句话。**说清这个模态的等待量级**，是它唯一该提醒的事。 */
const HINT_BY_KIND: Record<Kind, string> = {
  image: '图片即传即入库，几秒内可被检索',
  video: '视频转入写与抽帧后入库，要几分钟',
  audio: '音频转写成逐字稿后入库，要几分钟',
  text: '',
}

/** 拖放区主文案。 */
const DROP_LABEL_BY_KIND: Record<Kind, string> = {
  image: '点击选择图片，或把图片拖到这里',
  video: '点击选择视频，或把视频拖到这里',
  audio: '点击选择音频，或把音频拖到这里',
  text: '',
}

/** 拖放区副文案。格式名不出现，那是文件选择器自己的事（见上History说明）。 */
const SPEED_HINT_BY_KIND: Record<Kind, string> = {
  image: '常见图片格式都可以，一次能选多个',
  video: '常见视频格式都可以，一次选多个也可以，大的会慢一些',
  audio: '常见音频格式都可以，一次能选多个',
  text: '',
}

/** 模态的中文名。**从 ASSET_KINDS 派生而不是另写一份**：入库页的类型筛选条、
    检索页的筛选条、这里都用同一个来源，加一种模态只改一处。 */
const KIND_LABEL: Record<string, string> = Object.fromEntries(
  ASSET_KINDS.map((k) => [k.kind, k.label]),
)

/**
 * 批量标注结果的可见时长。**与素材库那个按钮保持一致**：两边是同一个操作的两个
 * 入口，一个 8 秒后消失、一个挂到刷新，用户会以为挂着的那个是出了什么问题。
 */
const BATCH_RESULT_TTL_MS = 8000

type Phase =
  | 'ready' // 已选好本地预览过，等点「开始入库」
  | 'waiting' // 已开跑，这一行还没轮到
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
  /**
   * 入库成功后落地的素材 id。**有了它，这一行才能直接编辑**：标题、描述、标签
   * 在刚入库时改最顺，人还记得这张图是什么。
   *
   * 图片在上传响应里就有；视频与音频要等后台任务跑完，从任务行的 result_json 里
   * 取（接口已透出，见 /api/ingest/jobs 的 publicJob）。
   */
  assetId?: number
  /** 本地 blob 地址，图片与视频都有。待命期预览、跑起来后核对「传的是这一条」 */
  localUrl?: string
  /**
   * 选中的 File 本体。**不随行渲染，只在开跑时交给 XHR。**
   * 待命阶段要能改主意（删掉某一行），所以从选到传之间隔了一次确认，这期间
   * 文件必须还在手上。
   */
  file?: File
  /**
   * 这一行是刷新后从服务端恢复的，不是本次选的。
   *
   * 它没有 File 也没有本地 blob 地址，所以预览按钮不能给：刷新之后浏览器再也
   * 拿不到原来那个 File 对象，给一个点下去必然报错的按钮比不给更糟。
   */
  restored?: boolean
  /**
   * AI 标注刚写进来的描述与标签。**只在本批会话里显示**，用来回答用户点完
   * 「AI 标注」之后那句「它到底看出了什么」。不进库的读取路径——库里已经有
   * 权威值了，这里只是本地回显。
   */
  aiCaption?: string
  aiTags?: string[]
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
  /** 入库成功后落地的素材 id，见 /api/ingest/jobs 的 publicJob */
  assetId?: number
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
  'frame-caption': '生成画面描述',
}

/**
 * 服务端任务 → 本地行。**只用于挂载时恢复**，正常选文件那条路不经过这里。
 *
 * phase 的映射必须与轮询那一侧逐字对齐（见下面 tick 里的四个分支）。两边不一致
 * 的后果不是报错，而是同一个任务在刷新前显示「转写中 40%」、刷新后变成
 * 「处理中 2%」——进度看着倒退，而人什么都没做。
 *
 * restored 标记让这一行不显示「预览」：刷新之后浏览器拿不到原来的 File 对象，
 * 本地预览无从播起。
 */
function jobToRow(j: JobSnapshot): Row {
  const done = j.status === 'done'
  const failed = j.status === 'error' || j.status === 'canceled'
  const queued = j.status === 'queued'
  const phase: Phase = failed ? 'error' : done ? 'done' : queued ? 'queued' : 'processing'
  return {
    key: `restored-${j.id}`,
    name: j.title,
    // 恢复的行拿不到文件大小：任务行里没有这一列，而为了显示一个数字去 stat
    // 一次磁盘不值得。留空由渲染侧隐藏，不显示 0KB 那种假数字。
    size: 0,
    kind: acceptOfKind(j.kind),
    phase,
    upload: 100,
    pct: j.percent,
    stage: queued ? '排队中' : (STAGE_LABEL[j.stage] ?? j.stage),
    detail: j.message || '',
    error: j.error ?? '',
    jobId: j.id,
    assetId: j.assetId,
    restored: true,
  }
}

/** 服务端 kind 字符串 → 本模块的 Kind。未知值当 null，那一行按「文件」显示。 */
function acceptOfKind(kind: string): Kind | null {
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : null
}

/**
 * 认不认这个文件。**必须先过本面板的模态关，再看扩展名**：顺序反了的话，在图片
 * 面板里拖进一个 mp4 会被判成 video 而放行，然后走 image 的入库分支报错。
 */
function kindOf(name: string, accept: Kind): Kind | null {
  return kindOfExt(name) === accept ? accept : null
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
  accept,
}: {
  collections: Array<{ id: number; name: string }>
  /** 当前选中的目标库，由页面从 URL 的 lib 参数传入 */
  currentCollectionId: number
  /** 本面板只收哪一种模态，见 Kind 的说明 */
  accept: Kind
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [targetId, setTargetId] = useState(currentCollectionId)
  const [rows, setRows] = useState<Row[]>([])
  // 哪一行正在模态预览。**是模态不是就地展开**：视频就地展开会把下面几行顶出
  // 视野，而预览只是一眼的事，不该改变背后任何元素的位置。见 MediaPreviewModal。
  const [previewKey, setPreviewKey] = useState<string | null>(null)
  // 关闭预览后焦点回到打开它的那个按钮，否则键盘用户被丢回页面开头
  const previewBtn = useRef<HTMLButtonElement | null>(null)
  // 正在编辑哪一行。关掉模态后焦点回到打开它的那个按钮。
  const [editKey, setEditKey] = useState<string | null>(null)
  const editBtn = useRef<HTMLButtonElement | null>(null)
  // 勾选了哪些行（按 key）。**入库成功的图片行才有勾选框**：没入库就没有可标注的
  // 对象，给一个勾了却报错的框是纯噪音。
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // 正在 AI 标注哪一行。用于把那一行的按钮换成「标注中」并禁用，避免连点。
  const [analyzingKey, setAnalyzingKey] = useState<string | null>(null)
  const [analyzeErr, setAnalyzeErr] = useState('')
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
  /**
   * 待命行的最新快照。**与 rows 同步维护，但读它不依赖渲染。**
   *
   * 为什么需要它：选完文件到点「开始入库」之间可能只隔几毫秒（输入框自动 focus，
   * 选完手一动就点）。stage() 的 setRows 是异步的，此刻组件还没重渲染，任何读
   * rows 的地方拿到的都是旧快照。按钮的 disabled 读到 0 就灰掉，start() 的 filter
   * 读到空数组直接 return，两者都静默——用户看到的是点什么都没发生。
   *
   * ref 的写入是同步的，stage() 一调它就变了，所以按钮与 start() 读它都对。
   * rows 仍然保留给渲染用，两者在每次 setRows 时一起更新。
   */
  const readyRef = useRef<Row[]>([])
  // 批次号。同一批文件复用同一个号，服务端据此把它们归成一组。
  const batchRef = useRef('')
  const batchStartedAt = useRef(0)

  const patch = useCallback((key: string, p: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }, [])

  /**
   * 挂载时把服务端还在跑的任务恢复成行。
   *
   * **这是右栏「后台任务」删掉之后必须补上的一件事。** 那一栏唯一独有的价值
   * 就是刷新页面后任务还在：左栏的行是 React state，整页刷新全丢，而视频与音频
   * 要跑几分钟，那几分钟里刷一下页面，人就再也看不到进度了。原来靠右栏兜这个
   * 底，代价是两块面板显示同一批任务、还要靠一句话解释它们口径不同。现在把兜底
   * 搬进左栏本身：进来先把未完成的任务查回来摆成行，一处显示，刷新不丢。
   *
   * **只恢复本模态的任务。** 三个模态的面板同时挂载（见入库页），各恢复各的，
   * 否则同一个任务会在三个面板里各出现一遍。用户只看得到当前那一个模态，看到
   * 的正好是自己关心的那类。
   *
   * 恢复出来的行没有 File 也没有本地预览地址，所以不显示「预览」按钮：刷新之后
   * 浏览器再也拿不到原来那个 File 对象，硬给一个按钮点下去只会报错。
   */
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    void (async () => {
      try {
        const r = await fetch('/api/ingest/jobs?queue=1', { cache: 'no-store' })
        const d = (await r.json()) as { ok: boolean; jobs?: JobSnapshot[] }
        if (!d.ok || !d.jobs) return
        const mine = d.jobs.filter((j) => j.kind === accept)
        if (mine.length === 0) return
        setRows((prev) => {
          // 已在列表里的不加第二遍：这个 effect 只在挂载时跑一次，但面板卸载重挂
          // （切模态再切回就是隐藏不是卸载，真正会重挂的是整页刷新）时可能赶上
          // 同一批任务还在跑。按 jobId 去重，不按 key，key 是本地生成的。
          const have = new Set(prev.map((r) => r.jobId).filter((x): x is number => x != null))
          const add: Row[] = mine
            .filter((j) => !have.has(j.id))
            .map((j) => jobToRow(j))
          return add.length > 0 ? [...prev, ...add] : prev
        })
      } catch {
        // 恢复失败不提示：面板照常可用，只是这一次看不到刷新前的进度
      }
    })()
  }, [accept])

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
                // 任务跑完才拿得到 assetId，此时这一行才能编辑
                assetId: j.assetId ?? row.assetId,
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

  /**
   * 选好了，只落在本地。
   *
   * **选了不传，等「开始入库」。** 早先选完即传，人来不及反悔：误选一个 1.9 GB
   * 的视频，取消都来不及它已经开始往服务端写；选错目录连带一整批进去，只能入库
   * 后再逐条删。现在是「选一批，看一眼，确认，再开跑」，选完到点按钮之间随时
   * 能删掉某一行。
   *
   * 本地预览地址两类都建：图片的意义是确认「我选的是这一张、没选错那张」，
   * 视频多一层「文件真能播、没损坏」。createObjectURL 是零拷贝，只是给
   * 浏览器内存里那个 File 起个能塞进 src 的名字，不读内容。
   */
  function stage(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    if (!batchRef.current) {
      batchRef.current = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }
    const batchId = batchRef.current

    const newRows: Row[] = list.map((f, i) => {
      const kind = kindOf(f.name, accept)
      const localUrl = URL.createObjectURL(f)
      const key = `${batchId}-${Date.now().toString(36)}-${i}-${f.name}`
      blobUrls.current.set(key, localUrl)
      return {
        key,
        name: f.name,
        size: f.size,
        kind,
        phase: 'ready',
        upload: 0,
        pct: 0,
        stage: '',
        detail: '',
        error: '',
        jobId: null,
        localUrl,
        file: f,
      }
    })
    // **ref 在 updater 之外直接赋值。** 写在 updater 里看着更「函数式」，但 React
    // 不保证 updater 何时被调用（严格模式下它会跑两次，未来版本还可能延后），
    // 于是「点开始入库」读到 ref 的时刻它可能还没被赋值。直接写是同步的，可靠。
    readyRef.current = [...rows, ...newRows].filter((r) => r.phase === 'ready')
    setRows((prev) => [...prev, ...newRows])
  }

  /** 把待命里的行开跑。只在待命态可点，跑起来后按钮转为禁用。 */
  async function start() {
    // **读 readyRef 而不是闭包里的 rows**，理由见 readyRef 的注释：选完文件到点
    // 按钮之间可能没有渲染间隙，读 rows 会拿到旧快照，于是静默返回。
    const ready = readyRef.current
    if (ready.length === 0 || runningRef.current) return
    runningRef.current = true
    // 这一批离开待命态。**同步清 ref**：否则按钮在重渲染前仍是可点的，
    // 连点会让同一批文件进两次库。
    readyRef.current = []
    batchStartedAt.current = Date.now()
    const batchId = batchRef.current

    // **先通知服务端「这批开始了」，再建行、再上传。** 顺序很重要：上传是整条
    // 链路最长的一段（1.91 GB 走局域网两分钟以上），若等上传完再建行，侧边栏
    // 队列在那几分钟里是空的，用户会以为任务没挂上。建行状态为 uploading，
    // 字节进度由 handleOne 轮番上报。
    //
    // 顺序即传入顺序，所以 jobIds[i] 与 ready[i] 一一对应。
    let jobIds: number[] = []
    try {
      const r = await fetch('/api/ingest/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId,
          collectionId: targetId,
          items: ready.map((r) => ({ name: r.name, kind: kindOf(r.name, accept) ?? undefined })),
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
      while (cursor < ready.length) {
        const i = cursor++
        await handleOne(ready[i], batchId, jobIds[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ready.length) }, worker))

    if (inputRef.current) inputRef.current.value = ''
    runningRef.current = false
    router.refresh()
  }

  /** 从待命里撤掉一行。**只在待命态出现**，跑起来之后撤不回来。 */
  /**
   * 给一行做 AI 标注。
   *
   * **标注完把结果直接写进行里**：标题、描述、标签都是这一行的字段，用户刚点完
   * 标注最想看到的就是「它看出了什么」。写进行里之后预览、编辑、勾选全都跟着是
   * 新的，不需要额外刷新。
   *
   * 失败不静默：把原因显示在这一行下方。视觉模型超时、key 失效、图损坏这三种
   * 原因的区分对用户有用（前两种要等或要配 key，第三种那张图本身有问题）。
   */
  async function analyzeOne(key: string) {
    const row = rows.find((r) => r.key === key)
    if (!row?.assetId || analyzingKey) return
    setAnalyzingKey(key)
    setAnalyzeErr('')
    try {
      const r = await fetch('/api/library/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.assetId }),
      })
      const d = (await r.json()) as {
        ok?: boolean
        analysis?: { title?: string; description?: string; tags?: string[] }
        error?: string
      }
      if (!d.ok) throw new Error(d.error ?? '标注失败')
      const a = d.analysis ?? {}
      patch(key, {
        name: a.title?.trim() || row.name,
        detail: a.description ? '已按 AI 标注更新' : row.detail,
        aiCaption: a.description ?? '',
        aiTags: a.tags ?? [],
      })
      router.refresh()
    } catch (e) {
      setAnalyzeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAnalyzingKey(null)
    }
  }

  /** 勾选了多少条可标注的图片行。 */
  const checkedRows = rows.filter((r) => checked.has(r.key) && r.assetId != null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchMsg, setBatchMsg] = useState('')
  // 批量的失败原因单独一份，不复用 analyzeErr：那个是挂在单张行下面的，
  // 复用它会把同一句错误在每一张图片行下面都显示一遍。
  const [batchErr, setBatchErr] = useState('')
  // 结果文案的消失计时。**不能不清**：它是这一次操作的回执，不是页面状态，
  // 挂一整天的「已标 3 张」只会变成噪音，还会让人分不清它说的是哪一批。
  const batchDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (batchDismissRef.current) clearTimeout(batchDismissRef.current)
    },
    [],
  )

  /** 到点清掉结果。反复设会重置计时，避免上一批的文案提前掀掉这一批的。 */
  function scheduleBatchDismiss() {
    if (batchDismissRef.current) clearTimeout(batchDismissRef.current)
    batchDismissRef.current = setTimeout(() => {
      setBatchMsg('')
      setBatchErr('')
    }, BATCH_RESULT_TTL_MS)
  }

  /**
   * 批量标注勾选的行。
   *
   * **走 SSE 而不是一次性等完**：十张图要一两分钟，期间界面完全不动比慢本身更让
   * 人焦虑。逐条进度推过来，用户看得到第几张了、还要多久。
   *
   * 读流用 getReader 而不是 await r.json()：后者要等整个响应体结束，那就把进度
   * 全丢了。每行是一条 JSON，边到边解析边更新。
   */
  async function analyzeChecked() {
    const ids = checkedRows.map((r) => r.assetId).filter((x): x is number => x != null)
    if (ids.length === 0 || batchBusy) return
    setBatchBusy(true)
    setBatchMsg(`开始标注 ${ids.length} 张`)
    setBatchErr('')
    try {
      const r = await fetch('/api/library/analyze/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      if (!r.ok || !r.body) throw new Error(`标注服务 ${r.status}`)
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let rest = ''
      let done = 0
      let total = ids.length
      let current = ''
      let okCount = 0
      let failed: CaptionFailure[] = []
      for (;;) {
        const { value, done: end } = await reader.read()
        if (end) break
        // 解析规则与素材库那边共用一份（feedCaptionStream）。两处各写一遍的结果是
        // 半行拼接、未知事件类型这些边角慢慢不一致，而它们出错时的表现都是
        // 「进度不动」或「整批被报成失败」，很难往解析上想。
        const fed = feedCaptionStream(rest, dec.decode(value, { stream: true }))
        rest = fed.rest
        for (const ev of fed.events) {
          if (ev.kind === 'progress') {
            done = ev.value.done
            total = ev.value.total || total
            current = ev.value.current
            setBatchMsg(`已标注 ${done}/${total}${current ? ` · ${current}` : ''}`)
          } else if (ev.kind === 'done') {
            okCount = ev.ok
            failed = ev.failed
          } else if (ev.kind === 'fatal') {
            throw new Error(ev.error)
          }
        }
      }
      setBatchMsg(summarizeCaptionRun(okCount, failed))
      if (failed.length) {
        setBatchErr(`失败 ${failed.slice(0, 3).map((f) => `#${f.assetId} ${f.error}`).join('；')}`)
      }
      // **有成功才清勾选。** 全失败时留着：那时候用户想做的就是重试，留着是一键
      // 重来；清了反而要他把同样的图再勾一遍。
      //
      // 清勾选还有个连带效应——它会让上面那个「已选 N 张」的容器整体消失，所以
      // 结果文案不能只放在那个容器里（见渲染处）。
      if (shouldClearSelectionAfterRun(okCount, failed)) setChecked(new Set())
      router.refresh()
      scheduleBatchDismiss()
    } catch (e) {
      setBatchMsg(e instanceof Error ? e.message : String(e))
      scheduleBatchDismiss()
    } finally {
      setBatchBusy(false)
    }
  }

  function unstage(key: string) {
    const next = rows.filter((r) => r.key !== key)
    readyRef.current = next.filter((r) => r.phase === 'ready')
    setRows(next)
    const url = blobUrls.current.get(key)
    if (url) {
      URL.revokeObjectURL(url)
      blobUrls.current.delete(key)
    }
  }

  async function handleOne(row: Row, batchId: string, jobId?: number) {
    const file = row.file
    if (!file || !row.kind) {
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
      patch(row.key, {
        phase: 'done',
        upload: 100,
        pct: 100,
        stage: '完成',
        detail: '已入库，可被检索',
        assetId: up.assetId,
      })
      return
    }

    // 视频与音频都只进后台队列：两者都是分钟级（抽帧转写 / 转写），不能占着
    // HTTP 连接让学生在浏览器前干等。带上 jobId，让服务端复用上传前建好的那一行，
    // 而不是另建一行——否则同一个文件在侧边栏里会先以「上传中」出现一遍、
    // 处理时又出现一遍，看着像两个任务。
    //
    // **两条路由同一形状，只是字段名不同**（videoPath / audioPath）。合起来写
    // 比复制一份好：复制的那份早晚有一边忘了带 jobId，而忘了不报错，只表现为
    // 侧边栏里同一个文件出现两次。
    const submitPathKey = accept === 'audio' ? 'audioPath' : 'videoPath'
    const submitUrl = accept === 'audio' ? '/api/ingest/audio' : '/api/ingest/video'
    patch(row.key, { phase: 'queued', upload: 100, pct: 2, stage: '排队中' })
    try {
      const r = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [submitPathKey]: up.path,
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
  const readyRows = rows.filter((r) => r.phase === 'ready')
  const readyCount = readyRows.length
  const previewRow = rows.find((r) => r.key === previewKey) ?? null
  const editRow = rows.find((r) => r.key === editKey) ?? null
  /**
   * 打开编辑模态时现取这一条的标注与标签。
   *
   * **不放在 Row 里**：Row 是本次会话的本地状态，刷新后从服务端恢复的行没有这两个
   * 字段，而视频音频入库后隔一会儿再改是常事。从库里读只有一处口径，代价是打开时
   * 多一次几十毫秒的请求，换来的是不会拿着过期值把别人的修改覆盖掉。
   *
   * 请求失败不阻塞编辑：caption 与 tags 退化成空，用户照常能填。真失败了由保存
   * 那一侧报错，那里才是必须成功的时刻。
   */
  const meta = useAssetMeta(editRow?.assetId ?? null)
  const doneCount = rows.filter((r) => r.phase === 'done').length
  const errorCount = rows.filter((r) => r.phase === 'error').length
  const overall = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length) : 0
  const activeName = rows.find((r) => r.phase === 'uploading' || r.phase === 'processing')?.name

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-neutral-200">入库</h2>
        <p className="text-xs text-neutral-400">{HINT_BY_KIND[accept]}</p>
      </div>

      {/*
        目标库。多库之后入库必须能选归属，否则建了库也只能进默认库，检索作用域
        就形同虚设。

        **id 按模态加后缀**：三个模态的面板现在同时挂载（见入库页的注释），
        共用一个 id 会让 label 的 htmlFor 只连到第一个，另两个面板点「入库到」
        这三个字没反应，而 select 照样能操作，这种半坏的状态最难查。
      */}
      <div className="mt-3 flex items-center gap-2">
        <label htmlFor={`ingest-collection-${accept}`} className="text-xs text-neutral-400">
          入库到
        </label>
        <select
          id={`ingest-collection-${accept}`}
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
          // 有 JS 时这条路不再上传，只落到待命态（见 stage）。**原生 form 的
          // 提交必须仍然可用**：无 JS 时用户点「开始入库」就是一次整页提交，
          // 由服务端 /api/ingest/form 一次收多个。为此按钮是 submit 而不是
          // button + onClick，两条路共用同一个 form。
          e.preventDefault()
          stage(inputRef.current?.files ?? null)
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
            // 其余连提示都没有。DataTransfer 也不需要了：直接交给 stage()。
            stage(e.dataTransfer.files)
          }}
        >
          <p className="text-sm text-neutral-400">{DROP_LABEL_BY_KIND[accept]}</p>
          {/*
            **不列扩展名。** 早先这里写「图片（jpg / jpeg / png / webp / gif / bmp）
            · 视频（mp4 / mov / mkv / webm / avi / m4v / flv / ts）」，两行 14 个
            扩展名。这是文件选择器自己知道的事（accept 已经传了），摆在前面的结果
            是把 onboarding 文案变成一段错误码，而用户真正需要的只有一句「我拍的
            这个能不能放进来」。视频会慢是关键信息，留它。
          */}
          <p className="mt-1 text-xs text-neutral-400">{SPEED_HINT_BY_KIND[accept]}</p>
          <input
            ref={inputRef}
            name="file"
            type="file"
            multiple
            accept={ACCEPT_BY_KIND[accept]}
            className="hidden"
            onChange={(e) => {
              // **选完只落在待命区，不传。** 早先是「选完即开始，不用再点按钮」，
              // 那是在拿「少一次点击」换「不能反悔」：误选一个 1.9 GB 的视频，
              // 它在你意识到之前已经开始往服务端写了。现在预览一眼再确认。
              //
              // 无 JS 时这个 handler 不存在，浏览器原生行为就是选完文件、
              // 等用户点「开始入库」整页提交，正好是同一套流程。
              stage(e.target.files)
            }}
          />
        </label>

        <button
          type="submit"
          formNoValidate
          // **不能用 readyCount 判禁用。** 它是 rows 派生的，而 rows 在 stage() 之后
          // 要等下一次渲染才更新；选完文件立刻点按钮时它还是 0，按钮被灰掉，点击
          // 根本不会发生。真实事故：界面卡在「等待中」、没有任何请求发出。
          //
          // 改用「点下去再说」：disabled 只挡正在跑的时候，够不够开始由 start()
          // 自己判（它读 readyRef，是同步最新的）。
          disabled={busy}
          onClick={(e) => {
            // 有 JS：一律拦掉原生提交，改走 start()。待命区是空的时候 start()
            // 自己会退出，不重复提交；真正在跑时 disabled 已经挡住点击。
            // **拦住是为了不双路提交**：同一次点击既走 fetch 又走原生 POST，
            // 结果同一个文件入两次库。
            e.preventDefault()
            void start()
          }}
          className="mt-3 w-full rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {busy ? '处理中…' : '开始入库'}
        </button>
      </form>

      {/*
        **待命区。** 选好的文件在这里排队，带本地缩略图，没点「开始入库」之前
        一个字节都不会往服务端传。存在的理由是「选错」：照片目录一次选三十张、
        里面混进两张截图，在待命区删掉即可，而早先选完即传，删只能入库后再删。

        图片用缩略图，视频用一方黑底加时长位。视频在这里不给 <video>：六七个
        <video> 同时预载 metadata 会让输入框都卡，而待命期只需要知道「是这个
        文件、多大」。单文件预览仍可点（见下面进度列表那一行）。
      */}
      {readyRows.length > 0 && (
        <div className="mt-4 rounded-md border border-neutral-800 bg-neutral-950/40 p-3">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-medium text-neutral-200">
              待入库 <span className="text-neutral-400">{readyRows.length} 个文件</span>
            </p>
            <button
              type="button"
              onClick={() => {
                for (const r of readyRows) unstage(r.key)
              }}
              className="text-xs text-neutral-400 underline hover:text-neutral-300"
            >
              全部撤掉
            </button>
          </div>
          <ul className="mt-2.5 grid grid-cols-4 gap-2 sm:grid-cols-6">
            {readyRows.map((r) => (
              <li key={r.key} className="group relative">
                <div className="aspect-square w-full overflow-hidden rounded border border-neutral-800 bg-neutral-900">
                  {r.kind === 'image' && r.localUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.localUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-400">
                      {r.kind === 'video' ? '视频' : '文件'}
                    </div>
                  )}
                </div>
                <p className="mt-1 truncate text-[10px] text-neutral-400" title={r.name}>
                  {r.name}
                </p>
                <button
                  type="button"
                  onClick={() => unstage(r.key)}
                  aria-label={`撤掉 ${r.name}`}
                  className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-neutral-950/80 text-xs text-neutral-300 hover:bg-red-950 hover:text-red-300 group-hover:flex"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-400">
            检查一下有没有选错，点上面的「开始入库」才会上传
          </p>
        </div>
      )}

      {/*
        **批量工具条只在勾选之后出现。**

        没有勾选时它是一个纯噪音条；勾了才出现，人才知道它是对着勾中的那些起作用的。
        这也是「批量」该有的样子：先选，再动手，动作条随之出现。

        放在进度列表上面而不是每行一个勾选框旁边：批量动作的作用对象是「这一批」，
        不是某一行，位置也该在批的层面。
      */}
      {checkedRows.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-neutral-700 bg-neutral-900/60 px-3 py-2">
          <span className="text-xs text-neutral-400">已选 {checkedRows.length} 张</span>
          <button
            type="button"
            disabled={batchBusy}
            onClick={() => void analyzeChecked()}
            className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:opacity-40"
          >
            {batchBusy ? batchMsg || '标注中' : `AI 标注这 ${checkedRows.length} 张`}
          </button>
          <button
            type="button"
            onClick={() => setChecked(new Set())}
            className="text-xs text-neutral-400 underline hover:text-neutral-300"
          >
            取消选择
          </button>
        </div>
      )}

      {/*
        批量标注的结果。**必须放在「已选 N 张」容器外面**：那个容器只在有勾选时
        渲染，而标注成功后会清勾选，放在里面的结果是「标完了反而看不到标了多少」。
        全失败时更要看到——那是唯一能告诉用户该重试还是该配 key 的一句话。
      */}
      {batchMsg && !batchBusy && (
        <p className="mt-2 text-xs text-neutral-400">{batchMsg}</p>
      )}
      {batchErr && <p className="mt-1 text-xs text-red-400">{batchErr}</p>}

      {rows.length > 0 && (
        <div className="mt-4 border-t border-neutral-800 pt-3">
          {/* 总览。视频是分钟级，明确告诉用户没卡死、还要等多久 */}
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-neutral-300">
              {doneCount}/{rows.length} 已完成
              {errorCount > 0 && <span className="text-red-400"> · {errorCount} 个失败</span>}
            </span>
            {busy && (
              <span className="text-neutral-400">
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
                  {r.phase === 'done' && r.assetId != null && r.kind === 'image' && (
                    <input
                      type="checkbox"
                      checked={checked.has(r.key)}
                      onChange={(e) => {
                        setChecked((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(r.key)
                          else next.delete(r.key)
                          return next
                        })
                      }}
                      aria-label={`选择 ${r.name}`}
                      className="flex-none accent-neutral-100"
                    />
                  )}
                  <span className="flex-none rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                    {KIND_LABEL[r.kind ?? ''] ?? '文件'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-200" title={r.name}>
                    {r.name}
                  </span>
                  {/* 恢复的行没有文件大小（任务行里没这一列），不显示 0KB 这种假数字 */}
                  {!r.restored && (
                    <span className="flex-none text-[10px] text-neutral-400">{fmtSize(r.size)}</span>
                  )}
                  {/* 待命行不显示阶段标签：它们还没开始，正在上面的待命区排队 */}
                  {r.phase !== 'ready' && <PhaseTag phase={r.phase} stage={r.stage} pct={r.pct} />}
                  {/*
                    本地预览。**放在等待中就能点**，这是它唯一有意义的地方：
                    上传 1.91 GB 要几分钟，那几分钟里服务端磁盘上什么都没有
                    （req.formData() 要等请求体读完才返回），不可能播服务端的
                    文件。播的是浏览器自己选中的那个 File，零网络、即时响应。
                    入库完成后仍可点，用来核对「我传上去的是这一条」。
                  */}
                  {r.localUrl && !r.restored && (
                    <button
                      ref={(el) => {
                        if (previewKey === r.key) previewBtn.current = el
                      }}
                      type="button"
                      onClick={() => setPreviewKey((k) => (k === r.key ? null : r.key))}
                      className="flex-none rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                    >
                      {previewKey === r.key ? '收起' : '预览'}
                    </button>
                  )}

                  {/*
                    编辑，紧跟预览旁边。**两个按钮作用在同一个对象上**（刚入库的
                    这一条），放一起才不用来回找；放别处都是把因果关系拆开。

                    只在入库成功且有 assetId 时出现：没入库成功就没有可改的对象。
                    视频与音频同样给，因为 result_json 里有 assetId，见 ingestRunner。
                  */}
                  {r.phase === 'done' && r.assetId != null && r.kind != null && (
                    <button
                      ref={(el) => {
                        if (editKey === r.key) editBtn.current = el
                      }}
                      type="button"
                      onClick={() => setEditKey(r.key)}
                      className="flex-none rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                    >
                      编辑
                    </button>
                  )}

                  {/*
                    AI 标注，只给图片。视频与音频没有「整片一个描述」这个字段，
                    让视觉模型看一张封面代替整片是在造一段假描述，所以不给这个入口。
                  */}
                  {r.phase === 'done' && r.assetId != null && r.kind === 'image' && (
                    <button
                      type="button"
                      disabled={analyzingKey !== null}
                      onClick={() => void analyzeOne(r.key)}
                      className="flex-none rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
                    >
                      {analyzingKey === r.key ? '标注中' : 'AI 标注'}
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
                  <span className="min-w-0 flex-1 truncate text-neutral-400">
                    {r.phase === 'uploading'
                      ? `上传中 ${r.upload}%`
                      : r.detail
                        ? r.detail
                        : r.stage
                          ? r.stage
                          : '等待中'}
                  </span>
                  {r.error && <span className="flex-none text-red-400">{r.error}</span>}
                  {analyzingKey === r.key && (
                    <span className="flex-none text-neutral-400">标注中…</span>
                  )}
                </div>

                {/*
                  AI 标注刚写完的回显。**只在本批会话里显示**：库里已有权威值，
                  这里回答的是「它看出了什么」，看一眼就能判断要不要再改。
                  不显示的代价是用户点完标注界面毫无变化，会以为没生效。
                */}
                {r.aiCaption && (
                  <p className="mt-1 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[10px] leading-4 text-neutral-400">
                    {r.aiCaption}
                  </p>
                )}
                {r.aiTags && r.aiTags.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {r.aiTags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                      >
                        {t}
                      </span>
                    ))}
                  </p>
                )}
                {analyzeErr && analyzingKey === null && r.assetId != null && r.kind === 'image' && (
                  <p className="mt-1 text-[10px] text-red-400">标注失败：{analyzeErr}</p>
                )}

              </li>
            ))}
          </ul>

          {!busy && doneCount > 0 && (
            <Link
              href={`/?lib=${targetId}`}
              className="mt-3 inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
            >
              去检索这个库
            </Link>
          )}
        </div>
      )}

      {/*
        预览模态。放在面板末尾而不是每一行里：行内那块已删（会把下面的内容顶
        下去），模态是浮层，写在哪个位置都不影响视觉位置。
      */}
      <MediaPreviewModal
        open={previewKey !== null}
        onClose={() => setPreviewKey(null)}
        kind={previewRow?.kind === 'text' ? null : (previewRow?.kind ?? null)}
        url={previewRow?.localUrl ?? ''}
        name={previewRow?.name ?? ''}
        returnFocusTo={previewBtn.current}
      />

      {/*
        编辑模态。**caption 与 tags 现从库里取**（useAssetMeta），不放在 Row 上：

        Row 是本次会话的本地状态，刷新后从服务端恢复的行本来就没有这两个字段；
        而视频与音频入库后用户随时可能改，从库里读只有一处口径。代价是打开模态时
        多一次请求，那是几十毫秒的事，换来的是不会拿着过期值覆盖别人的修改。
      */}
      {editRow && editRow.assetId != null && editRow.kind != null && (
        <AssetEditModal
          open
          onClose={() => setEditKey(null)}
          assetId={editRow.assetId}
          kind={editRow.kind === 'image' ? 'image' : editRow.kind === 'video' ? 'video' : 'audio'}
          title={editRow.name}
          caption={meta?.caption ?? ''}
          tags={meta?.tags ?? []}
          returnFocusTo={editBtn.current}
          onSaved={() => router.refresh()}
        />
      )}
    </section>
  )
}

/**
 * 取一条素材的标注与标签。id 为 null 时不发请求。
 */
function useAssetMeta(id: number | null): { caption: string; tags: string[] } | null {
  const [meta, setMeta] = useState<{ caption: string; tags: string[] } | null>(null)
  useEffect(() => {
    if (id == null) {
      setMeta(null)
      return
    }
    let alive = true
    void (async () => {
      try {
        const r = await fetch(`/api/library/${id}`, { cache: 'no-store' })
        const d = (await r.json()) as {
          ok?: boolean
          asset?: { caption?: string | null; tags?: string[] }
        }
        if (alive && d.ok) setMeta({ caption: d.asset?.caption ?? '', tags: d.asset?.tags ?? [] })
      } catch {
        if (alive) setMeta({ caption: '', tags: [] })
      }
    })()
    return () => {
      alive = false
    }
  }, [id])
  return meta
}

function PhaseTag({ phase, stage, pct }: { phase: Phase; stage: string; pct: number }) {
  const tone =
    phase === 'error'
      ? 'text-red-400'
      : phase === 'done'
        ? 'text-emerald-400'
        : phase === 'waiting'
          ? 'text-neutral-400'
          : 'text-neutral-300'
  const text =
    phase === 'ready'
      ? '待入库'
      : phase === 'waiting'
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
