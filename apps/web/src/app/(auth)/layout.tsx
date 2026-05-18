import { AuthShell } from '@/components/shell/auth-shell'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthShell>{children}</AuthShell>
}
