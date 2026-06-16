import Link from 'next/link'

import styles from './ui.module.css'

const s = (name: string) => styles[name]

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

type CommonProps = {
  children: React.ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
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

function classes(variant: ButtonVariant, size: ButtonSize, className?: string) {
  return `${s('button')} ${s(`button_${variant}`)} ${s(`button_${size}`)} ${className ?? ''}`.trim()
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? 'primary'
  const size = props.size ?? 'md'

  if (props.href !== undefined) {
    // Internal routes use next/link for client-side navigation; external/hash use <a>.
    if (props.href.startsWith('/')) {
      return (
        <Link className={classes(variant, size, props.className)} href={props.href}>
          {props.children}
        </Link>
      )
    }
    return (
      <a className={classes(variant, size, props.className)} href={props.href}>
        {props.children}
      </a>
    )
  }

  const { type = 'button', onClick, disabled, loading, children, className } = props
  return (
    <button
      className={classes(variant, size, className)}
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <>
          <span className={s('spinner')} aria-hidden="true" />
          <span>Working…</span>
        </>
      ) : (
        children
      )}
    </button>
  )
}
