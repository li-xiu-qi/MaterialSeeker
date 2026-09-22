'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * 删除索引按钮。整个素材库里唯一需要 JS 的动作，所以单独做成一个小岛，
 * 不把整个页面拖成客户端组件。
 *
 * 删除只摘索引不动源文件，删前要确认，删完刷新服务端渲染的列表。
 * JS 失效时这个按钮点不动，但列表内容照常可看。
 */
export function LibraryDeleteButton({ id, title }: { id: number; title: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [removing, setRemoving] = useState(false)

  function remove() {
    if (!window.confirm(`删除「${title}」的索引？源文件不会被删除。`)) return
    setRemoving(true)
    fetch(`/api/library/${id}`, { method: 'DELETE' })
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error ?? '删除失败')
        startTransition(() => router.refresh())
      })
      .catch((e) => window.alert(e instanceof Error ? e.message : String(e)))
      .finally(() => setRemoving(false))
  }

  return (
    <button
      type="button"
      disabled={removing || pending}
      onClick={remove}
      className="h-fit flex-none rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-red-700 hover:text-red-300 disabled:opacity-40"
    >
      {removing ? '删除中' : '删除索引'}
    </button>
  )
}
