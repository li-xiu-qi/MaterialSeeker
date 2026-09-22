'use client'

import { useState } from 'react'
import { fmtMs } from '@/lib/format'

/**
 * 逐字稿命中卡片。核心是定位播放：给出封面、命中区间与命中句，
 * 展开后 <video> 用 #t= 定位到命中起始秒。
 *
 * 本文件是客户端组件，不能 import 任何含 node 内置模块的文件（Turbopack
 * 会 panic）。视频与封面的 URL 由服务端算好后当 prop 传进来。
 *
 * 类型与来源的中文名、相似度百分数由外层 ResultList 统一渲染，这里不再
 * 重复一行表头。
 *
 * 播放器按需加载（点了才渲染 <video>），否则三十条结果会同时开三十路
 * 视频流。media 路由支持 Range，所以拖动进度条可用。
 */

export interface SentenceHit {
  start_ms: number
  end_ms: number
  text: string
}

interface Props {
  assetTitle: string
  videoUrl: string | null
  coverUrl: string | null
  chunkText: string
  startMs: number
  endMs: number
  sentences: SentenceHit[]
}

export function ChunkResultCard({
  assetTitle,
  videoUrl,
  coverUrl,
  chunkText,
  startMs,
  endMs,
  sentences,
}: Props) {
  const [open, setOpen] = useState(false)

  const seekTo = videoUrl ? `${videoUrl}#t=${Math.floor(startMs / 1000)}` : null

  return (
    <div className="mt-2">
      <div className="flex gap-3">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="h-20 w-36 flex-none rounded border border-neutral-800 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="h-20 w-36 flex-none rounded border border-neutral-800 bg-neutral-800" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-200">{assetTitle}</p>
          <p className="mt-1 text-sm text-neutral-300">{chunkText}</p>

          <div className="mt-2 flex items-center gap-2">
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300">
              {fmtMs(startMs)} - {fmtMs(endMs)}
            </span>
            <span className="text-[11px] text-neutral-600">{sentences.length} 句</span>
            {videoUrl && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-neutral-500"
              >
                {open ? '收起' : '定位播放'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 句级展开：每一句都可单独定位 */}
      {sentences.length > 1 && (
        <ul className="mt-2 space-y-0.5 border-t border-neutral-800 pt-2">
          {sentences.map((s, i) => (
            <li key={i} className="flex gap-2 text-[11px] text-neutral-500">
              <span className="font-mono tabular-nums">{fmtMs(s.start_ms)}</span>
              <span className="min-w-0 flex-1">{s.text}</span>
            </li>
          ))}
        </ul>
      )}

      {open && seekTo && (
        <div className="mt-3">
          <video
            key={seekTo}
            src={seekTo}
            controls
            autoPlay
            preload="metadata"
            className="w-full rounded border border-neutral-800 bg-black"
          />
          <p className="mt-1 text-[11px] text-neutral-600">
            已定位到 {fmtMs(startMs)}，可拖动进度条查看前后文
          </p>
        </div>
      )}

      {!videoUrl && (
        <p className="mt-2 text-[11px] text-neutral-600">文本笔记，无对应视频文件</p>
      )}
    </div>
  )
}
