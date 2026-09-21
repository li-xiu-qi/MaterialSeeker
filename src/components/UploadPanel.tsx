'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type Stage = 'idle' | 'uploading' | 'video-processing' | 'done' | 'error'

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
  const [log, setLog] = useState<string[]>([])

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-30), line])
  }, [])

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return

    for (const file of Array.from(files)) {
      const kind = kindOf(file.name)
      if (!kind) {
        append(`跳过 ${file.name}：不支持的格式`)
        continue
      }

      setStage('uploading')
      append(`上传 ${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`)

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
        continue
      }

      // 视频：上传只落地，这一步驱动处理
      setStage('video-processing')
      append(`视频已落地，开始处理 ${up.path}`)
      try {
        const r = await fetch('/api/ingest/video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoPath: up.path }),
        })
        const d = await r.json()
        if (!d.ok) {
          setStage('error')
          setMessage(d.error ?? '视频处理失败')
          return
        }
        append(
          `视频处理完成：${d.frameCount} 帧、${d.sentenceCount} 句、${d.chunkCount} 块（策略 ${d.strategy}）`,
        )
      } catch (e) {
        setStage('error')
        setMessage(`视频处理失败: ${e instanceof Error ? e.message : String(e)}`)
        return
      }
    }

    setStage('done')
    setMessage('全部处理完成')
    router.refresh()
  }

  return (
    <section className="mt-8 rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <h2 className="text-sm font-medium text-neutral-200">入库</h2>
      <p className="mt-1 text-xs text-neutral-500">
        图片上传即入库；视频上传后需等待转写与抽帧（分钟级，请勿关闭页面）
      </p>

      <div
        className="mt-3 cursor-pointer rounded-md border border-dashed border-neutral-700 p-6 text-center transition hover:border-neutral-500"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          onFiles(e.dataTransfer.files)
        }}
      >
        <p className="text-sm text-neutral-400">点击选择或拖拽文件到此处</p>
        <p className="mt-1 text-xs text-neutral-600">
          支持图片（{IMAGE_EXTS.join(' / ')}）与视频（{VIDEO_EXTS.join(' / ')}）
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={[...IMAGE_EXTS, ...VIDEO_EXTS].map((e) => `.${e}`).join(',')}
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {stage !== 'idle' && (
        <p
          className={`mt-3 text-xs ${
            stage === 'error' ? 'text-red-400' : stage === 'done' ? 'text-emerald-400' : 'text-neutral-400'
          }`}
        >
          {message || stage}
        </p>
      )}

      {log.length > 0 && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-neutral-950 p-2 text-[11px] leading-5 text-neutral-500">
          {log.join('\n')}
        </pre>
      )}
    </section>
  )
}
