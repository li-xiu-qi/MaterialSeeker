/**
 * 素材模态。**这是全库唯一的事实源**（kind 列没有 CHECK 约束，见 db.ts 的
 * migrateKinds）。
 *
 * 四种模态各自的检索路径不一样，这是数据结构决定的：
 * - video：帧向量 + 帧描述向量 + 逐字稿 chunk 向量 + 全文字
 * - image：图片向量 + 描述向量
 * - audio：逐字稿 chunk 向量 + 全文字（没有画面那一路）
 * - text：正文向量 + 关键词
 *
 * **定义放在这个文件而不是 db.ts**：db.ts 顶层 import better-sqlite3（native
 * module），客户端组件碰不得它，而这个类型在入库面板、检索筛选条这些客户端
 * 组件里都要用。放在这里，客户端只需要一个不含 native 依赖的纯模块。
 */
export type AssetKind = 'video' | 'image' | 'audio' | 'text'

/**
 * 扩展名 → 素材模态。**全库唯一一份。**
 *
 * 早先 UploadPanel、上传路由、素材类型判断各写一份 Set，加音频时三处都要改，
 * 漏一处的表现很分裂：前端选得进而服务端 400，或反过来服务端收得下而前端根本
 * 不让你选。集中到这里之后，加一种模态只改这一处，另两处自动跟上。
 *
 * 只按扩展名判，不看 MIME：浏览器给的 file.type 对 mkv/flac 这类容器常常是
 * 空串，而扩展名永远有（没有扩展名的文件会被判为未知类型，这条路是明确的拒绝，
 * 不是猜）。
 */

/** 扩展名一律小写、带点。调用方负责 toLowerCase。 */
const IMAGE = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'] as const
const VIDEO = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts'] as const
/**
 * 音频。**mp4/m4a/mov 是同一家容器**，但 mp4 里通常是视频，所以视频表先判、
 * 音频表只收纯音频扩展名。反过来的话用户传一个 mp4 会被当成音频，转写服务拿它
 * 抽音轨倒是也能跑，但这条素材就成了「没有画面的视频」，是另一类错误。
 */
const AUDIO = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.opus'] as const

export const KINDS_BY_EXT = {
  IMAGE_EXTS: new Set<string>(IMAGE),
  VIDEO_EXTS: new Set<string>(VIDEO),
  AUDIO_EXTS: new Set<string>(AUDIO),
} as const

/** 取扩展名（小写带点）。没有点或名字以点结尾时返回空串。 */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i).toLowerCase()
}

export function kindOfExt(name: string): AssetKind | null {
  const ext = extOf(name)
  if (KINDS_BY_EXT.VIDEO_EXTS.has(ext)) return 'video'
  if (KINDS_BY_EXT.IMAGE_EXTS.has(ext)) return 'image'
  if (KINDS_BY_EXT.AUDIO_EXTS.has(ext)) return 'audio'
  return null
}

export function isImageExt(name: string): boolean {
  return kindOfExt(name) === 'image'
}

export function isVideoExt(name: string): boolean {
  return kindOfExt(name) === 'video'
}

export function isAudioExt(name: string): boolean {
  return kindOfExt(name) === 'audio'
}

/**
 * 四种模态的中文名与顺序。**新增模态只改这里**，检索的类型筛选条、入库的
 * 四个入口都从它派生，不再各写一份。
 *
 * 放在这个文件而不是 db.ts：这是纯常量，页面拿它拼筛选条，而从 db.ts 导入会
 * 连带加载 better-sqlite3（native module），为一个字符串数组连一次库不划算。
 */
export const ASSET_KINDS: ReadonlyArray<{ kind: AssetKind; label: string }> = [
  { kind: 'video', label: '视频' },
  { kind: 'image', label: '图片' },
  { kind: 'audio', label: '音频' },
  { kind: 'text', label: '文本' },
]
