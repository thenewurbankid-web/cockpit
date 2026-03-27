import { useState } from 'react'
import { LoginPage } from './pages/LoginPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { HomePage } from './pages/HomePage'

type Page = 'login' | 'forgot-password' | 'home'

export default function App() {
  const [page, setPage] = useState<Page>('login')

  function navigate(p: Page) { setPage(p) }

  if (page === 'forgot-password') return <ForgotPasswordPage navigate={navigate} />
  if (page === 'home') return <HomePage navigate={navigate} />
  return <LoginPage navigate={navigate} />
}
