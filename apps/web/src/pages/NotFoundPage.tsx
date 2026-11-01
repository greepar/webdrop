import { Link } from 'react-router-dom'
import { BrandMark } from '@/shared/ui/Icon'

export function NotFoundPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-6 text-center">
      <BrandMark className="size-20" />
      <h1 className="text-2xl font-semibold tracking-tight">找不到这个页面</h1>
      <Link to="/" className="text-sm text-accent underline underline-offset-4">回到首页</Link>
    </main>
  )
}
