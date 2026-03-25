interface InputProps {
  id?: string
  type?: string
  label?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
test?: any
}

export function Input({ label = "test", id, type = 'text', value, onChange, placeholder, disabled , test}: InputProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} >
      <label htmlFor={id} style={{ fontSize: '0.875rem', fontWeight: 500, color: '#374151' }}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{
          padding: '0.5rem 0.75rem',
          border: '1px solid #d1d5db',
          borderRadius: 26,
          fontSize: '0.95rem',
          outline: 'none',
          transition: 'border-color 0.15s',
        }}
      />

    </div>
  )
}




