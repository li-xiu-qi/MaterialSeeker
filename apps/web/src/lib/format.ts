/**
 * 纯展示用的格式化函数。这个文件不能 import 任何 node 内置模块：
 * 它会被客户端组件引用，客户端 bundle 含 node:fs/node:path 会让
 * Turbopack 直接 panic。
 */

/**
 * 毫秒 → m:ss。
 *
 * 负值按 0 处理。毫秒字段来自数据库，正常不会为负，但这个函数被逐字稿、
 * 关键帧、结果卡片三处展示共用，任何一个上游算出负差值都会让它把
 * `-1:-1` 这样的东西直接摆到界面上。展示函数的契约是自己不产出怪东西。
 */
export function fmtMs(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 余弦相似度 → 百分数。相似度是 0 到 1 的余弦值，乘 100 后取整。
 * 只用于展示，不要把百分数当概率解读。
 */
export function fmtScore(score: number): string {
  return `${Math.round(score * 100)}%`
}

/** 命中类型的中文名。内部字段名（chunk/frame/image）不该出现在界面上。 */
export function typeLabel(type: string): string {
  switch (type) {
    case 'chunk':
      return '台词'
    case 'frame':
      return '关键帧'
    case 'image':
      return '图片'
    case 'audio':
      return '音频'
    default:
      return type
  }
}

/** 命中来源的中文名。向量路的几张面孔要能区分，但不暴露英文路由名。 */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'vector':
      return '语义匹配'
    case 'keyword':
      return '关键词'
    case 'frame_vector':
      return '画面'
    case 'caption_vector':
      return '画面描述'
    case 'image_vector':
      return '图片'
    case 'audio_vector':
      return '音频内容'
    default:
      return source
  }
}
