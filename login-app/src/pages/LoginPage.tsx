import { useState } from 'react'
import { Input } from '../components/Input'
import { Button } from '../components/Button'

async function fakeLogin(email: string, _password: string): Promise<void> {
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      if (email === 'admin@example.com') resolve()
      else reject(new Error('Invalid credentials'))
    }, 800)
  )
}





export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await fakeLogin(email, password)
      setSuccess(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div style={styles.wrapper}>
        <p style={{ color: '#16a34a', fontWeight: 600 }}>Logged in successfully!</p>
      </div>
    )
  }

  return (
    <div style={styles.wrapper}>
      <form onSubmit={handleSubmit} style={styles.form} noValidate>
        <h2 style={styles.title}>Sign in</h2>




        <Input
          id="email-id"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="admin@example.com"
          disabled={loading}
          test="test" />

        <Input
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
          disabled={loading}
        />

        {error && <p style={styles.error}>{error}</p>}

        <Button type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

    </div>







  )
}



const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5f5',
  },
  form: {
    background: '#fff',
    padding: '2rem',
    borderRadius: 8,
    boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
    width: 320,
  },
  title: {
    margin: 0,
    fontSize: '1.4rem',
    fontWeight: 700,
    color: '#111',
  },
  error: {
    margin: 0,
    color: '#dc2626',
    fontSize: '0.875rem',
  },
}

