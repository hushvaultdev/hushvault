import { AuthShell } from '@/components/shell/auth-shell'

// Reset/verify links carry tokens in the URL fragment; never leak them via Referer.
export const metadata = { referrer: 'no-referrer' as const }

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthShell>{children}</AuthShell>
}
