import Link from 'next/link'

export default function NotFound() {
  return (
    <main style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: '24px 16px' }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: 8 }}>Page not found</h1>
        <p style={{ color: 'var(--muted, #6b7280)', marginBottom: 16 }}>
          That page does not exist. If you followed a share link, check that you copied the whole URL.
        </p>
        <Link href="/">Back to HushVault</Link>
      </div>
    </main>
  )
}
