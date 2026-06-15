import styles from './ui.module.css'

const s = (name: string) => styles[name]

type FieldProps = {
  label: string
  name: string
  type?: 'text' | 'email' | 'password'
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  autoComplete?: string
  hint?: string
}

export function Field({
  label,
  name,
  type = 'text',
  value,
  onChange,
  placeholder,
  required,
  autoComplete,
  hint,
}: FieldProps) {
  return (
    <label className={s('field')}>
      <span className={s('fieldLabel')}>{label}</span>
      <input
        className={s('input')}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        autoComplete={autoComplete}
      />
      {hint ? <span className={s('fieldHint')}>{hint}</span> : null}
    </label>
  )
}
