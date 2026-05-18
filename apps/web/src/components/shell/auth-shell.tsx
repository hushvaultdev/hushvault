import styles from './auth-shell.module.css'

const s = (name: string) => styles[name]

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={s('authShell')}>
      <div className={`${s('container')} page-container`}>{children}</div>
    </div>
  )
}
