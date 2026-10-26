'use client'

/**
 * 滚轮友好的下拉框。**原生 select 的一个坑：鼠标停在它上面拨滚轮，滚轮被用来
 * 改选中项，页面纹丝不动。**
 *
 * 这不是本项目的问题，是浏览器的既定行为，但在素材库页上后果很难看：页面顶部
 * 就摆着「当前库」下拉框，用户刚从侧边栏点进来、鼠标往往正停在这一带，往下拨
 * 滚轮时库在悄悄切换、页面一步不动。从界面上看就是「滚轮坏了」。
 *
 * **做法是渐进增强，不是替代原生控件**：底下还是一个真正的 `<select>`，原生
 * 表单提交、无 JS 可用、键盘操作全部保留。有 JS 时只多做一件事——把吞掉滚轮的
 * 那个默认动作拦下来，并替页面滚同样的距离。没有 JS 时退回原生行为（滚轮改
 * 选项），功能依然完整，只是滚不动页面。
 *
 * 取舍：这个做法会让「展开下拉后用滚轮选选项」失效。那一幕很边缘（展开后通常
 * 用点击或方向键），而滚轮滚不动页面几乎每次都能撞上。
 */

import type { SelectHTMLAttributes } from 'react'

export function ScrollSafeSelect({
  onWheel,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      onWheel={(e) => {
        // 先让调用方自己的处理跑，再决定要不要接管
        onWheel?.(e)
        if (e.defaultPrevented) return
        // 拦下「改选项」，改为滚页面。距离照搬，用户拨多少滚多少，
        // 不放大也不加惯性，避免和触控板的连续事件叠成抽搐。
        e.preventDefault()
        const main = document.querySelector('main')
        if (main) main.scrollBy({ top: e.deltaY, behavior: 'instant' })
        else window.scrollBy({ top: e.deltaY, behavior: 'instant' })
      }}
    />
  )
}
