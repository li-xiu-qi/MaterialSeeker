/**
 * segmentit 的最小类型声明。
 *
 * 包不自带类型（package.json 只有 main 指向 dist/cjs，无 types 字段），
 * strict 模式下会报 TS2307。只声明本项目用到的 API 面，不覆盖整个包：
 * doSegment 的 options 也只声明用到的 simple，其余参数同样可用但类型是宽泛的。
 */

declare module 'segmentit' {
  export interface DoSegmentOptions {
    simple?: boolean
    [key: string]: unknown
  }

  export class Segment {
    doSegment(text: string, options?: DoSegmentOptions): string[]
  }

  export function useDefault(segment: Segment): Segment

  const segmentit: {
    Segment: typeof Segment
    useDefault: typeof useDefault
  }
  export default segmentit
}
