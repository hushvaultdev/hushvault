import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'HushVault',
    template: '%s | HushVault',
  },
  description: 'Secrets manager for modern teams. Better workflow features, lower friction, and pricing that scales with you.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
