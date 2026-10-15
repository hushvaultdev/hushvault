import type { Metadata } from 'next'

import { AuthProvider } from '@/lib/auth-context'

import '@hushvault/web-kit/styles/globals.css'

export const metadata: Metadata = {
  title: { default: 'HushVault Admin', template: '%s | HushVault Admin' },
  description: 'Platform administration.',
  // Never indexed: this app must not appear in any search result even if Access were misconfigured.
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
