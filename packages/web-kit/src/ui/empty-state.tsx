import styles from './ui.module.css'

const s = (name: string) => styles[name]

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className={s('emptyState')}>
      <h3 className={s('emptyTitle')}>{title}</h3>
      <p className={s('emptyText')}>{description}</p>
      {action ? <div className={s('emptyAction')}>{action}</div> : null}
    </div>
  )
}
