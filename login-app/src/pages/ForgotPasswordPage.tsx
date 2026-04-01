import { useState } from 'react'
import { Input } from '../components/Input'
import { Button } from '../components/Button'

type Page = 'login' | 'forgot-password' | 'home'

interface ForgotPasswordPageProps {
  navigate: (page: Page) => void
}

async function fakeSendReset(_email: string): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 900))
}

export function ForgotPasswordPage({ navigate }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) { setError('Please enter your email address.'); return }
    setError(null)
    setLoading(true)
    try {
      await fakeSendReset(email)
      setSent(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        {/* Logo */}
        <div style={styles.iconWrap}>
          <span style={styles.icon}>🔑</span>
        </div>

        <h2 style={styles.title}>Forgot password?</h2>
        <p style={styles.subtitle}>
          Enter your email and we'll send you a link to reset your password.
        </p>

        {sent ? (
          <div style={styles.successBox}>
            <span style={styles.successIcon}>✓</span>
            <p style={styles.successText}>
              Reset link sent! Check your inbox at <strong>{email}</strong>.
            </p>
            <button style={styles.linkBtn} onClick={() => navigate('login')}>
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={navigate} style={styles.form} noValidate>
            <Input
              id="reset-email"
              label="Email "
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              disabled={loading}
            />

            {error && <p style={styles.error}>{error}</p>}

            <Button type="submit" disabled={loading}>
              {loading ? 'Sending…' : 'Send reset link'}
            </Button>

            <button
              type="button"
              style={styles.linkBtn}
              onClick={() => navigate('login')}
            >
              ← Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f3f4f6',
    padding: '1rem',
  },
  card: {
    background: '#fff',
    borderRadius: 12,
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    padding: '2.5rem 2rem',
    width: '100%',
    maxWidth: 400,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '1rem',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: '#eff6ff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: '0.25rem',
  },
  icon: { fontSize: '1.6rem' },
  title: {
    margin: 0,
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#111827',
    textAlign: 'center',
  },
  subtitle: {
    margin: 0,
    fontSize: '0.875rem',
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 1.5,
  },
  form: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  error: {
    margin: 0,
    fontSize: '0.85rem',
    color: '#dc2626',
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: 6,
    padding: '0.5rem 0.75rem',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    fontSize: '0.875rem',
    cursor: 'pointer',
    padding: 0,
    textAlign: 'center',
    textDecoration: 'underline',
    alignSelf: 'center',
  },
  successBox: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '1rem',
    background: '#f0fdf4',
    border: '1px solid #86efac',
    borderRadius: 8,
  },
  successIcon: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: '#16a34a',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.1rem',
    fontWeight: 700,
  },
  successText: {
    margin: 0,
    fontSize: '0.875rem',
    color: '#166534',
    textAlign: 'center',
    lineHeight: 1.5,
  },
}
