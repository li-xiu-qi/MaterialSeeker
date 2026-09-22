'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type Stage = 'idle' | 'uploading' | 'video-processing' | 'done' | 'error'

interface DoneItem {
  kind: 'image' | 'video'
  title: string
  detail: string
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'flv', 'ts']

function kindOf(name: string): 'image' | 'video' | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (IMAGE_EXTS.includes(ext)) return 'image'
  if (VIDEO_EXTS.includes(ext)) return 'video'
  return null
}

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
  const [stage, setStage] = useState<Stage>('idle')
  const [message, setMessage] = useState('')
  const [done, setDone] = useState<DoneItem[]>([])
  const [log, setLog] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-30), line])
  }, [])

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    const results: DoneItem[] = []

    for (const file of Array.from(files)) {
      const kind = kindOf(file.name)
      if (!kind) {
        append(`跳过 ${file.name}：不支持的格式`)
        continue
      }

      setStage('uploading')
      setMessage(`正在上传 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`)

      const fd = new FormData()
      fd.append('file', file)
      fd.append('collectionId', String(targetId))
      let up: { ok: boolean; kind?: string; path?: string; assetId?: number; error?: string }
      try {
        const r = await fetch('/api/upload', { method: 'POST', body: fd })
        up = await r.json()
      } catch (e) {
        setStage('error')
        setMessage(`上传失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      if (!up.ok) {
        setStage('error')
        setMessage(up.error ?? '上传失败')
        return
      }

      if (up.kind === 'image') {
        append(`图片已入库 asset #${up.assetId}`)
        results.push({ kind: 'image', title: file.name, detail: '已入库，可被检索' })
        continue
      }

      setStage('video-processing')
      setMessage(`正在处理 ${file.name}：转写与抽帧，可能需要几分钟`)
      try {
        const r = await fetch('/api/ingest/video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: up.path, title: file.name, collectionId: targetId }),
        })
        const d = await r.json()
        if (!d.ok) {
          setStage('error')
          setMessage(d.error ?? '视频处理失败')
          return
        }
        append(`视频处理完成：${d.frameCount} 帧、${d.sentenceCount} 句、${d.chunkCount} 块`)
        results.push({
          kind: 'video',
          title: file.name,
          detail: `${d.frameCount} 帧 · ${d.sentenceCount} 句 · ${d.chunkCount} 块`,
        })
      } catch (e) {
        setStage('error')
        setMessage(`视频处理失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }

    setDone(results)
    setStage('done')
    setMessage(`完成 ${results.length} 个文件`)
    router.refresh()
  }

  const stageTone =
    stage === 'error'
      ? 'border-red-800 bg-red-950/40 text-red-300'
      : stage === 'done'
        ? 'border-emerald-800 bg-emerald-950/40 text-emerald-300'
        : stage === 'idle'
          ? 'border-neutral-800 bg-neutral-900/40 text-neutral-400'
          : 'border-neutral-700 bg-neutral-800/60 text-neutral-200'

  return (
    <section className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-neutral-200">入库</h2>
        <p className="text-[11px] text-neutral-600">图片即传即入库，视频需等待转写与抽帧</p>
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

      <form action="/api/ingest/form" method="post" encType="multipart/form-data">
        <input type="hidden" name="collectionId" value={targetId} />

        {/*
          用 label 包住文件输入，而不是 div 上挂 onClick 调 input.click()。
          label 关联的文件输入被点击时浏览器原生打开对话框，这条路不依赖 JS；
          此前那种写法在客户端 JS 不执行时点它毫无反应（用户实测踩到过）。
        */}
        <label
          className="mt-3 block cursor-pointer rounded-md border border-dashed border-neutral-700 p-6 text-center transition hover:border-neutral-500 hover:bg-neutral-800/30"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const f = e.dataTransfer.files?.[0]
            if (f && inputRef.current) {
              // 拖进来的文件塞回 input，走同一条提交路径
              const dt = new DataTransfer()
              dt.items.add(f)
              inputRef.current.files = dt.files
              inputRef.current.form?.requestSubmit()
            }
          }}
        >
          <p className="text-sm text-neutral-400">点击选择，或把文件拖到这里</p>
          <p className="mt-1 text-xs text-neutral-600">
            图片（{IMAGE_EXTS.join(' / ')}）· 视频（{VIDEO_EXTS.join(' / ')}）
          </p>
          <input
            ref={inputRef}
            name="file"
            type="file"
            accept={[...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',')}
            className="hidden"
            onChange={(e) => {
              // 有 JS 时选完文件即提交，不用再点按钮。JS 失效时按钮仍在，
              // 原生提交整页刷新，服务端入库后重定向回本页，结果照常看得到。
              if (e.target.files?.length) e.currentTarget.form?.requestSubmit()
            }}
          />
        </label>

        <button
          type="submit"
          className="mt-3 w-full rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900"
        >
          开始入库
        </button>
      </form>

      {/* 状态条：上传中、出错、完成三种都要一眼看到 */}
      {stage !== 'idle' && (
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${stageTone}`}>
          <p>{message}</p>
          {(stage === 'uploading' || stage === 'video-processing') && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded bg-neutral-800">
              <div className="h-full w-1/3 animate-pulse rounded bg-neutral-400" />
            </div>
          )}
        </div>
      )}

      {/* 入库结果：让用户看到刚刚发生了什么，并能直接跳到搜索 */}
      {done.length > 0 && (
        <ul className="mt-3 space-y-1">
          {done.map((d, i) => (
            <li key={i} className="flex items-center gap-2 text-[11px] text-neutral-400">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5">
                {d.kind === 'image' ? '图片' : '视频'}
              </span>
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              <span className="text-neutral-600">{d.detail}</span>
              <span className="text-neutral-700">
                {collections.find((c) => c.id === targetId)?.name ?? ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {done.length > 0 && (
        <Link
          href={`/?lib=${targetId}`}
          className="mt-3 inline-block rounded-md border border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
        >
          去检索这个库
        </Link>
      )}

      {log.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="text-[11px] text-neutral-600 hover:text-neutral-400"
          >
            {showLog ? '收起过程记录' : `展开过程记录（${log.length}）`}
          </button>
          {showLog && (
            <pre className="mt-2 max-h-32 overflow-auto rounded bg-neutral-950 p-2 text-[11px] leading-5 text-neutral-600">
              {log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}
