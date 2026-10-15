import type { Metadata } from 'next'

import { AuthProvider } from '@/lib/auth-context'

import '@hushvault/web-kit/styles/globals.css'

export const metadata: Metadata = {
  title: {
    default: 'HushVault',
    template: '%s | HushVault',
  },
  description: 'Open source secrets management for developers. HushVault is pre-release software; review current capabilities and security limits before use.',
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
