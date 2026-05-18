import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'

import styles from '../auth.module.css'

const s = (name: string) => styles[name]

export default function SignInPage() {
  return (
    <main className={s('authPage')}>
      <Section className={s('authSection')}>
        <Card className={s('authCard')} tone="light">
          <span className="eyebrow">Welcome back</span>
          <h1>Sign in to HushVault</h1>
          <p className={s('authText')}>
            Use GitHub or Google to sign in quickly, or continue with email and password if preferred.
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
              Password
              <input type="password" placeholder="••••••••" />
            </label>
            <Button href="#" variant="primary">Sign In</Button>
          </form>
          <p className={s('authFooter')}>
            New to HushVault? <a href="/sign-up">Create an account</a>.
          </p>
        </Card>
      </Section>
    </main>
  )
}
