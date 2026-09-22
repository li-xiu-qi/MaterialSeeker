import { LibraryView } from '@/components/LibraryView'

export const dynamic = 'force-dynamic'

export default function LibraryPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold">素材库</h1>
      <p className="mt-1 text-sm text-neutral-400">已入库的全部素材，按类型分组</p>
      <div className="mt-8">
        <LibraryView />
      </div>
    </main>
  )
}
