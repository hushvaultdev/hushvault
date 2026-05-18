import { MarketingFooter } from '@/components/shell/marketing-footer'
import { MarketingHeader } from '@/components/shell/marketing-header'

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-shell">
      <MarketingHeader />
      {children}
      <MarketingFooter />
    </div>
  )
}