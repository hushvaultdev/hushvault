import styles from './ui.module.css'

const s = (name: string) => styles[name]

type BadgeTone = 'accent' | 'neutral' | 'success'

export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: BadgeTone }) {
  return <span className={`${s('badge')} ${s(`badge_${tone}`)}`}>{children}</span>
}