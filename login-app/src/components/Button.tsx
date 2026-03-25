interface ButtonProps {
  children: React.ReactNode
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  onClick?: () => void
}

export function Button({ children, type = 'button', disabled, onClick }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: '0.6rem 1.25rem',
        background: disabled ? '#9ca3af' : '#2563eb',
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        fontSize: '0.95rem',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.15s',
      }}
    >
      {children}
    </button>
  )
}
