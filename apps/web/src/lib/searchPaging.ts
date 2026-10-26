/**
 * 检索结果的分页常数。**从检索页抽出来，只为可测。**
 *
 * 与 libraryFilter 里那几个常数同一个理由：数值一旦写死在页面组件里，就只能靠
 * 「改完看一眼」发现，而第二页、上限、空态这些分支在首页根本走不到。抽成模块后
 * 可以由测试钉住几个不变量。
 */

/**
 * 一页显示多少条结果。
 *
 * 取 12 是因为结果卡片比素材库卡片高得多：一条结果带封面、标题、时间戳，四栏一屏
 * 只放得下三四条，十二条已经超出首屏。首屏之外靠翻页，而不是一次倒出一百条让用户
 * 滚三分屏才见到底。
 */
export const RESULT_PAGE = 12

/**
 * 翻页的实际上限。**钉死在服务端之外的第二道闸。**
 *
 * 服务端的 topK 会再钳一次，但页面这一侧也要钳：不钳的话用户手打 `?s=99999`，
 * 页面会按 99999 去请求，而服务端只返回它自己的上限，两边对不上时表现为「点数
 * 都没变」，看不出是谁拦的。
 *
 * 定 200 而不是更大： cosine 是全表暴力扫描，每多一条候选只多一次句子查询，但
 * 合并排序的内存与前端 DOM 是实打实的。两百条之后用户更该去收窄检索范围。
 */
export const MAX_RESULT_SHOWN = 200

/**
 * 多取一条作为「还有下一页」的探针。只按 shown 请求时，返回值长度最多等于 shown，
 * 调用方永远不可能知道后面是否还有结果。
 */
export function resultRequestSize(shown: number): number {
  return Math.min(Math.max(1, shown + 1), MAX_RESULT_SHOWN)
}

/** 当前页只展示 shown 条，额外那条只用于判断是否有更多结果。 */
export function resultWindow<T>(hits: T[], shown: number): { items: T[]; hasMore: boolean } {
  return {
    items: hits.slice(0, shown),
    hasMore: shown < MAX_RESULT_SHOWN && hits.length > shown,
  }
}

/**
 * 翻页要带上的当前状态。**q 与 m 都不能丢。**
 *
 * 丢 q 的话翻页链接指向落地页，点一下搜索词就没了；丢 m 的话翻页后类型筛选被
 * 重置成「全部」，结果是第二页混进了第一页被筛掉的类型——两页内容看起来毫无关系，
 * 而用户只会以为搜索坏了。
 */
export function resultParams(query: string, modality: string, lib: string): URLSearchParams {
  const p = new URLSearchParams()
  if (query) p.set('q', query)
  if (modality !== 'all') p.set('m', modality)
  if (lib) p.set('lib', lib)
  return p
}
