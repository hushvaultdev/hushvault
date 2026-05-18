import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'

import styles from '../auth.module.css'

const s = (name: string) => styles[name]

export default function SignUpPage() {
  return (
    <main className={s('authPage')}>
      <Section className={s('authSection')}>
        <Card className={s('authCard')} tone="light">
          <span className="eyebrow">Get started</span>
          <h1>Create your HushVault account</h1>
          <p className={s('authText')}>
            Start free and keep your secrets secure as your project grows. Sign up with GitHub, Google, or email.
          </p>
          <div className={s('authActions')}>
            <Button href="#" variant="secondary">Continue with GitHub</Button>
            <Button href="#" variant="secondary">Continue with Google</Button>
          </div>
          <div className={s('divider')}>
            <span>or</span>
          </div>
          <form className={s('authForm')}>
            <label>
              Email
              <input type="email" placeholder="you@example.com" />
            </label>
            <label>
              Full name
              <input type="text" placeholder="Jane Doe" />
            </label>
            <label>
              Password
              <input type="password" placeholder="••••••••" />
            </label>
            <Button href="#" variant="primary">Create account</Button>
          </form>
          <p className={s('authFooter')}>
            Already have an account? <a href="/sign-in">Sign in</a>.
          </p>
        </Card>
      </Section>
    </main>
  )
}
