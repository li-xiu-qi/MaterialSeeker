'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * 列表里的内联编辑。**管理页上直接改，不用跳详情页**：用户在素材库里扫视时
 * 发现标题或描述不对，改它就是顺手的事，跳转到详情页再跳回来会丢掉当前的
 * 筛选与栏数状态。
 *
 * 三种素材共用一个组件，可改的字段由 kind 决定：
 * - 图片：标题 + 画面描述（存在 images.caption）
 * - 文本：标题 + 正文（存在 text_notes.content）
 * - 视频：只有标题。视频的描述是逐帧的，没有整片字段，见 updateAssetMeta 的说明。
 *
 * JS 失效时这个按钮点不动，但本页其他功能照常，删除与批量操作也另有不需要
 * 它的路径（详情页上的原生表单）。这是小岛，不是页面的前提。
 */
export function LibraryEditButton({
  id,
  kind,
  title,
  annotation,
  annotationLabel,
}: {
  id: number
  kind: 'image' | 'video' | 'text'
  title: string
  /** 现有的标注内容，图片是画面描述，文本是正文 */
  annotation: string
  annotationLabel: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [t, setT] = useState(title)
  const [a, setA] = useState(annotation)

  async function save() {
    setSaving(true)
    setErr('')
    try {
      const body: { title?: string; caption?: string } = {}
      if (t.trim() && t.trim() !== title) body.title = t.trim()
      // 只在标注真的可编辑时才发这个字段：视频发过去会被服务端拒掉，
      // 而拒掉是对的（没有整片字段），不该让用户看到那个错误。
      if (kind !== 'video' && a !== annotation) body.caption = a
      if (Object.keys(body).length === 0) {
        setOpen(false)
        return
      }
      const r = await fetch(`/api/library/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await r.json()
      if (!d.ok) throw new Error(d.error ?? '保存失败')
      setOpen(false)
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-fit rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
      >
        {open ? '收起' : '编辑'}
      </button>

      {open && (
        <span className="mt-2 block w-full space-y-2 rounded-md border border-neutral-700 bg-neutral-950 p-3">
          <span className="block text-[11px] text-neutral-500">标题</span>
          <input
            value={t}
            onChange={(e) => setT(e.target.value)}
            maxLength={120}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-neutral-500"
          />

          {kind !== 'video' && (
            <>
              <span className="block text-[11px] text-neutral-500">{annotationLabel}</span>
              <textarea
                value={a}
                onChange={(e) => setA(e.target.value)}
                rows={kind === 'text' ? 6 : 3}
                className="w-full resize-y rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] leading-5 text-neutral-200 outline-none focus:border-neutral-500"
              />
              <span className="block text-[11px] text-neutral-700">
                保存后重新计算检索特征，要等一两秒
              </span>
            </>
          )}

          {err && <span className="block text-[11px] text-red-400">{err}</span>}

          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded bg-neutral-100 px-3 py-1 text-[11px] font-medium text-neutral-900 disabled:opacity-40"
            >
              {saving ? '保存中' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setErr('')
              }}
              className="text-[11px] text-neutral-600 hover:text-neutral-300"
            >
              取消
            </button>
          </span>
        </span>
      )}
    </span>
  )
}
