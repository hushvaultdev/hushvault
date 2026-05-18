import styles from './ui.module.css'

const s = (name: string) => styles[name]

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

type ButtonProps = {
  children: React.ReactNode
  href: string
  variant?: ButtonVariant
}

export function Button({ children, href, variant = 'primary' }: ButtonProps) {
  return (
    <a className={`${s('button')} ${s(`button_${variant}`)}`} href={href}>
      {children}
    </a>
  )
}