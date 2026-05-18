import styles from './marketing-shell.module.css'

const s = (name: string) => styles[name]

const footerGroups = [
  {
    title: 'Product',
    links: [
      { href: '#workflows', label: 'Workflow' },
      { href: '#pricing', label: 'Pricing' },
      { href: '/faq', label: 'FAQ' },
      { href: '#trust', label: 'Security' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { href: '/docs', label: 'Docs' },
      { href: '/docs/ARCHITECTURE.md', label: 'Architecture' },
      { href: '/docs/ENCRYPTION.md', label: 'Encryption' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/README.md', label: 'Open source' },
      { href: '/CLAUDE.md', label: 'Roadmap context' },
      { href: '/LICENSE', label: 'MIT license' },
    ],
  },
]

export function MarketingFooter() {
  return (
    <footer className={s('footerWrap')}>
      <div className={`${s('footer')} page-container`}>
        <div className={s('footerIntro')}>
          <p className={s('footerKicker')}>HushVault</p>
          <h2>Secrets management built for developer momentum, startup budget, and team trust.</h2>
          <p>
            Give developers the useful workflow features immediately, then add governance when the organization actually needs it.
          </p>
        </div>

        <div className={s('footerGrid')}>
          {footerGroups.map((group) => (
            <div key={group.title} className={s('footerGroup')}>
              <h3>{group.title}</h3>
              {group.links.map((link) => (
                <a key={link.label} href={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </div>
      </div>
    </footer>
  )
}