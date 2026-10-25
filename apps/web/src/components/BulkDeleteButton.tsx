'use client'

/**
 * 批量删除按钮。**小岛组件**：整个素材库页是服务端直出的，只有这一步需要 JS。
 *
 * 需要 JS 的原因是要在提交前确认。原生 HTML 没有「点了先问一句」的手段，
 * details 两步确认倒是可以，但它要求按钮和确认框在同一个 details 里，而这里的
 * 按钮要用 form 属性远程提交另一份隐藏表单（勾选项分散在列表各行，不能把整段
 * 列表包进一个 form，那样 HTML 非法）。两者不好共存。
 *
 * 取舍：有 JS 时多一道确认，没 JS 时照旧能删但少了确认。删除的兜底保障不在
 * 交互层——它只删索引记录，文件仍在素材目录，误删可恢复。
 */
export function BulkDeleteButton({ formId, count }: { formId: string; count: number }) {
  return (
    <button
      type="submit"
      form={formId}
      onClick={(e) => {
        const form = e.currentTarget.form ?? document.getElementById(formId)
        if (!form) return
        const picked = form.querySelectorAll('input[type="checkbox"]:checked').length
        const n = picked || count
        if (!window.confirm(`删除所选 ${n} 条素材？\n\n文件仍保留在素材目录，之后可重新入库。`)) {
          e.preventDefault()
        }
      }}
      className="rounded border border-neutral-700 px-2 py-0.5 text-xs text-neutral-400 hover:border-red-700 hover:text-red-300"
    >
      删除所选
    </button>
  )
}
