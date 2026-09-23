/**
 * 素材库列表的类型与筛选条件。**从 library.ts 抽出来，只为可测。**
 *
 * library.ts 顶层 import better-sqlite3（经 db.ts 与 collections.ts），那是 native
 * module，在没编译过的环境里装不上也加载不了。而本文件的函数全是纯函数，一行 db
 * 都不碰。搬过来之后，测试只需这个文件，不必为了断言一条筛选规则去搭一个数据库。
 *
 * 搬过来的不只是函数：LibraryList 的类型定义也跟着走，因为它是这些函数的入参。
 * library.ts 从这里 re-export，页面与接口的 import 路径都不用变。
 */

export interface LibraryCounts {
  video: number
  image: number
  text: number
}

/**
 * 一页的返回。三类各带三个数，分开而不要合成一个：
 *
 * counts 是**库内存量**，不受筛选与 limit 影响，页面顶部那行「视频 2 · 图片 140 ·
 *   文本 3」说的是库的存量。把它按筛选收窄会让用户以为库被删空了。
 * total 是**当前筛选下的命中总数**，判断「还有没有下一页」只看它。
 * hasMore 是 total 与已显示条数比出来的结果，页面直接拿来决定显不显示「加载更多」。
 */
/** 每一类是否还有未显示的条目。**是布尔，不是条数**——页面只问「还有没有」 */
export interface LibraryHasMore {
  video: boolean
  image: boolean
  text: boolean
}

export interface LibraryList {
  counts: LibraryCounts
  total: LibraryCounts
  hasMore: LibraryHasMore
  /** true 表示这次没按库过滤，此时各行必须显示 collectionName */
  allCollections: boolean
  video: Array<{
    id: number
    title: string
    sourcePath: string | null
    createdAt: string
    cover: string | null
    frames: number
    chunks: number
    sentences: number
    collectionId: number
    collectionName: string
  }>
  image: Array<{
    id: number
    title: string
    sourcePath: string | null
    mediaPath: string | null
    createdAt: string
    caption: string | null
    hasVector: boolean
    hasCaptionVector: boolean
    collectionId: number
    collectionName: string
  }>
  text: Array<{
    id: number
    title: string
    sourcePath: string | null
    createdAt: string
    content: string
    chars: number
    hasVector: boolean
    collectionId: number
    collectionName: string
  }>
}

export interface LibraryFilter {
  kind?: 'video' | 'image' | 'text'
  /** 标题与说明的模糊匹配，中文按子串走 LIKE，不依赖分词 */
  q?: string
}

export interface LibraryQuery extends LibraryFilter {
  /** 每一类最多取多少条。不给 = 不限制 */
  limit?: number
}

/**
 * 一页的上限。**页面与服务端共用这一个数。**
 *
 * 服务端拿它钳 URL 传上来的 n，页面拿它钳自己算出来的 shown。两边各写一个数字
 * 的后果是页面算出 300 而服务端只给 200，用户点了「显示更多」却一条都没多出来。
 */
export const MAX_PAGE = 200

/**
 * 把用户输入的关键词变成 LIKE 的参数值。**转义 % _ 三个字符。**
 *
 * 不转义的后果不是匹配少，是匹配多：用户搜「100%」会命中所有标题里带「10」的
 * 条目，搜「a_b」时下划线是单字符通配。这种错误在界面上表现为「搜了个偏门的词，
 * 结果反而全出来了」，很难想到是通配符。
 *
 * 返回的值要配 `ESCAPE '\'` 用，SQL 那一侧由 libraryWhere 统一加上。
 */
export function likePattern(q: string | undefined): string | null {
  const kw = q?.trim() ?? ''
  if (!kw) return null
  return `%${kw.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

/**
 * 筛选条件 → SQL WHERE 片段与绑定参数。**纯函数，筛选规则只此一份。**
 *
 * 规则是从界面上翻过车的地方提炼的，每条都对应一次真实故障：
 *
 * **类型不进这个片段，由各查询自己写 a.kind = ?**。因为页面要的是「某类在本次
 *   筛选下有多少条」，而不是「把三类混在一起再拆开」：三类分别 LIMIT 分别计数，
 *   每类各自知道有没有下一页。混在一起取再拆，第一批 24 条可能全是图片，视频
 *   那段就空着，用户以为视频素材丢了。
 *
 * **关键词按标题走，图片额外加画面描述**。视频与文本没有整片的描述字段（视频
 *   是逐帧的，文本的正文不进 images.caption），给它们加 caption 只会匹配到
 *   null，白搜一场还会让人以为搜索坏了。
 *
 * **大小写交给 LIKE。** SQLite 的 LIKE 对 ASCII 大小写不敏感，中文没有大小写，
 *   统一不处理比两套规则好推。
 *
 * 片段以 `AND` 开头（没命中条件时是空串），直接拼在 WHERE 之后即可，调用方不必
 * 判断要不要补连接词。
 */
export function libraryWhere(filter: LibraryFilter): {
  sql: string
  args: unknown[]
  /** 命中条件时返回转义后的模式串，否则 null。给调用方做日志与断言用 */
  kw: string | null
} {
  const pattern = likePattern(filter.q)
  if (!pattern) return { sql: '', args: [], kw: null }

  // 图片多一列 caption。用 columns 数组而不是 if/else 两套分支写死 SQL，
  // 是为了「哪些列参与匹配」这件事在本文件里只有一处可读。
  const columns = filter.kind === 'image' ? ['a.title', 'im.caption'] : ['a.title']
  const sql = `AND (${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`
  // 每个 ? 都要一个绑定值。切片补齐是为了 columns 增加时不必回来改这里
  const args = columns.map(() => pattern)
  return { sql, args, kw: pattern }
}
