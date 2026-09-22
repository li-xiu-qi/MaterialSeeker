import { AppShell } from '@/components/AppShell'

/**
 * 应用外壳布局：把常驻导航包住所有页面。
 *
 * 外壳只管导航与主区。检索范围不在这层解析：它是页面级参数，layout 拿不到
 * searchParams，也不该由一个全局外壳替所有页面决定「现在在哪个库里」。
 * 各页面自己用 CollectionScope 呈现（检索页与素材库页都有）。
 *
 * 根 layout 只管 html/body 与全局样式，这里只管导航外壳。将来要放不带边栏的
 * 页面（全屏预览之类），另开一个路由组即可，不用给外壳加开关。
 */
export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppShell>{children}</AppShell>
}
