import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'HushVault',
  description: 'Secrets manager built for the edge. $0 to self-host.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
