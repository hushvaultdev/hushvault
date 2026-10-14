import styles from './ui.module.css'

const s = (name: string) => styles[name]

export function Section({
  children,
  className,
  id,
}: {
  children: React.ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={`${s('section')} ${className ?? ''}`.trim()}>
      {children}
    </section>
  )
}