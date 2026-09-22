'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

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

export function UploadPanel() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
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
          body: JSON.stringify({ videoPath: up.path, title: file.name }),
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

      <div
        className="mt-3 cursor-pointer rounded-md border border-dashed border-neutral-700 p-6 text-center transition hover:border-neutral-500 hover:bg-neutral-800/30"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          onFiles(e.dataTransfer.files)
        }}
      >
        <p className="text-sm text-neutral-400">点击选择，或把文件拖到这里</p>
        <p className="mt-1 text-xs text-neutral-600">
          图片（{IMAGE_EXTS.join(' / ')}）· 视频（{VIDEO_EXTS.join(' / ')}）
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={[...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',')}
          className="hidden"
          onChange={(e) => {
            onFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

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
            </li>
          ))}
        </ul>
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
