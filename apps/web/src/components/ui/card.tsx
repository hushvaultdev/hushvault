import styles from './ui.module.css'

const s = (name: string) => styles[name]

type CardTone = 'light' | 'dark'

export function Card({
  children,
  className,
  tone = 'light',
}: {
  children: React.ReactNode
  className?: string
  tone?: CardTone
}) {
  return <div className={`${s('card')} ${s(`card_${tone}`)} ${className ?? ''}`.trim()}>{children}</div>
}