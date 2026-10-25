import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '素材搜索 MaterialSeeker',
  description: '多模态内容检索工作台',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  )
}
