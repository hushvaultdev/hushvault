import styles from './marketing-shell.module.css'

const s = (name: string) => styles[name]

const REPO_BLOB = 'https://github.com/hushvaultdev/hushvault/blob/main'

type FooterLink = { href: string; label: string; external?: boolean }

const footerGroups: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { href: '/#workflows', label: 'Workflow' },
      { href: '/#pricing', label: 'Pricing' },
      { href: '/faq', label: 'FAQ' },
      { href: '/#trust', label: 'Security' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { href: '/docs', label: 'Docs' },
      { href: `${REPO_BLOB}/docs/ARCHITECTURE.md`, label: 'Architecture', external: true },
      { href: `${REPO_BLOB}/docs/ENCRYPTION.md`, label: 'Encryption', external: true },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: `${REPO_BLOB}/README.md`, label: 'Open source', external: true },
      { href: `${REPO_BLOB}/LICENSE`, label: 'MIT license', external: true },
    ],
  },
]

export function MarketingFooter() {
  return (
    <footer className={s('footerWrap')}>
      <div className={`${s('footer')} page-container`}>
        <div className={s('footerIntro')}>
          <p className={s('footerKicker')}>HushVault</p>
          <h2>Secrets management built for developer momentum and startup budgets. Early, pre-release, and open source.</h2>
          <p>
            Give developers the useful workflow features immediately, then add governance when the organization actually needs it.
          </p>
        </div>

        <div className={s('footerGrid')}>
          {footerGroups.map((group) => (
            <div key={group.title} className={s('footerGroup')}>
              <h3>{group.title}</h3>
              {group.links.map((link) => (
                link.external ? (
                  <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer">
                    {link.label}
                  </a>
                ) : (
                  <a key={link.label} href={link.href}>
                    {link.label}
                  </a>
                )
              ))}
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}