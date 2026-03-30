import { useState } from 'react'

/** Tiny "i" icon that shows a popover on hover. */
export function InfoIcon({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 4 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <span style={{
        width: 14, height: 14, borderRadius: '50%', border: '1px solid #6c7086',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 700, color: '#6c7086', cursor: 'default',
        fontFamily: 'serif', fontStyle: 'italic', lineHeight: 1, flexShrink: 0,
      }}>i</span>
      {show && (
        <div style={{
          position: 'absolute', left: '50%', top: '100%', transform: 'translateX(-50%)',
          marginTop: 6, padding: '6px 10px', background: '#1e1e2e', border: '1px solid #45475a',
          borderRadius: 6, color: '#cdd6f4', fontSize: 11, lineHeight: 1.45,
          whiteSpace: 'normal', width: 220, zIndex: 1000, pointerEvents: 'none',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)', fontFamily: 'system-ui, sans-serif',
          fontWeight: 400, textTransform: 'none', letterSpacing: 0,
        }}>{text}</div>
      )}
    </span>
  )
}
