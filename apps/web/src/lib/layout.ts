/**
 * 素材库页的栏数与由它推出的布局。**从 library/page.tsx 抽出来，只为可测。**
 *
 * 抽出来的理由不是「页面太长」，是这几个常量正是本项目连续踩坑的地方：
 * 双栏四栏曾经整块不生效、而控制台一声不响，根因是 Tailwind 按源码里出现过的
 * 字面类名生成 CSS。这种缺陷在页面上只能靠「改完看一眼」发现，而单栏状态下
 * 那几个类根本用不到，看不出来。所以把它们连同约束一起搬进能被断言的文件，
 * 由测试守住「三个档位都有值且互不相同」。
 *
 * **搬走之后 Tailwind 照样扫得到。** Tailwind v4 的 @import "tailwindcss" 扫的是
 * 整个源码树（按 .gitignore 排除），不限于 app 目录，所以 lib 下的类名字面量
 * 一样参与生成。不要因为「类名不在页面文件里了」又把它搬回去。
 */

/** 列表栏数。**走 URL 参数，不用客户端 state。** */
export type Cols = 1 | 2 | 4

export const COL_OPTIONS = [
  { value: '1', label: '单栏' },
  { value: '2', label: '双栏' },
  { value: '4', label: '四栏' },
] as const

/**
 * URL 的 c 参数 → 栏数。**非法值一律回落 1，不抛错。**
 *
 * 回落而不是报错，是因为这个参数用户可以手打；回落成单栏至少看得见东西，
 * 报错会让整页 500。c=3、c=0、c=abc、空串都走这条路。
 */
export function parseCols(c: string | undefined): Cols {
  return c === '2' ? 2 : c === '4' ? 4 : 1
}

/**
 * 栏数对应的列表容器类。**必须写死成字面量，不能拿变量去拼栅格类名。**
 *
 * Tailwind 按源码里出现过的字面类名生成 CSS，模板字符串拼出来的类名在构建时
 * 不存在，扫不到就不会生成，结果是双栏四栏看着没生效、控制台也不报错。这类坑
 * 靠「改完看一眼」发现不了，因为单栏本来就没用到这几个类。守卫测试会扫源码里
 * 有没有人在拼栅格类名，所以连注释里也不要写那种形式。
 *
 * 单栏保持 space-y-3 的竖排间距；多栏用 grid，卡片高度不一时由 grid 自动对齐。
 */
export const LIST_CLS: Record<Cols, string> = {
  1: 'mt-3 space-y-3',
  2: 'mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2',
  4: 'mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4',
}

/**
 * 缩略图按栏数分级请求尺寸。缩略图不是请求越大越清晰，是「源图够铺满显示区域
 * 就行」：二栏卡片内容宽约 409px，仍按单栏的 192px 请求会被拉成 2.2 倍放大，
 * 肉眼可见地糊；四栏约 199px，192px 刚好不放大。所以一栏给 192（显示只有 128px），
 * 二栏给 640，四栏给 384。
 *
 * 同样是字面量常量，理由同 LIST_CLS：构建时要能扫到具体值。
 */
export const THUMB_W: Record<Cols, number> = {
  1: 192,
  2: 640,
  4: 384,
}

/** 视频封面帧的请求宽度，分级理由同 THUMB_W */
export const COVER_W: Record<Cols, number> = {
  1: 256,
  2: 640,
  4: 384,
}
