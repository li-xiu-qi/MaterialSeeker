/**
 * 品牌标记。与 src/app/icon.svg 同源设计（放大镜 + 山），侧边栏与将来的
 * 分享卡片用它保持识别一致。**不要在别处另画一个 logo**：两份图形漂移
 * 之后，「 favicon 是放大镜、侧边栏是别的形状」比没有 logo 更糟。
 */

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="MaterialSeeker"
      className="flex-none rounded-md"
    >
      <rect width="24" height="24" rx="6" fill="#171717" />
      <circle cx="10.5" cy="10.5" r="5" fill="none" stroke="#f5f5f5" strokeWidth="2" />
      <path d="M8 13 L10 9.8 L11.8 12 L12.9 10.4 L14.8 13 Z" fill="#f5f5f5" />
      <line
        x1="14.4"
        y1="14.4"
        x2="18.5"
        y2="18.5"
        stroke="#fbbf24"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
