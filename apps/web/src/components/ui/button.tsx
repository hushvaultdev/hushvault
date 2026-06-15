import Link from 'next/link'

import styles from './ui.module.css'

const s = (name: string) => styles[name]

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

type CommonProps = {
  children: React.ReactNode
  variant?: ButtonVariant
  className?: string
}

type LinkProps = CommonProps & { href: string }

type ActionProps = CommonProps & {
  href?: undefined
  type?: 'button' | 'submit'
  onClick?: () => void
  disabled?: boolean
  loading?: boolean
}

type ButtonProps = LinkProps | ActionProps

function classes(variant: ButtonVariant, className?: string) {
  return `${s('button')} ${s(`button_${variant}`)} ${className ?? ''}`.trim()
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? 'primary'

  if (props.href !== undefined) {
    // Internal routes use next/link for client-side navigation; external/hash use <a>.
    if (props.href.startsWith('/')) {
      return (
        <Link className={classes(variant, props.className)} href={props.href}>
          {props.children}
        </Link>
      )
    }
    return (
      <a className={classes(variant, props.className)} href={props.href}>
        {props.children}
      </a>
    )
  }

  const { type = 'button', onClick, disabled, loading, children, className } = props
  return (
    <button
      className={classes(variant, className)}
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
    >
      {loading ? 'Working…' : children}
    </button>
  )
}
