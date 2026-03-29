import { useState, useMemo } from 'react'
import { IfExpression } from '../expressions/IfExpression'

type Page = 'login' | 'forgot-password' | 'home'

interface HomePageProps {
  navigate: (page: Page) => void
}

interface Product {
  id: number
  name: string
  category: 'Design' | 'Engineering' | 'Marketing'
  status: 'Active' | 'Inactive'
  price: string
  description: string
  avatar: string
}

const PRODUCTS: Product[] = [
  { id: 1, name: 'Dashboard Pro', category: 'Design', status: 'Active', price: '$49/mo', description: 'Full analytics suite with real-time charts.', avatar: '📊' },
  { id: 2, name: 'CodeSync', category: 'Engineering', status: 'Active', price: '$29/mo', description: 'Real-time code collaboration for distributed teams.', avatar: '⚙️' },
  { id: 3, name: 'CampaignKit', category: 'Marketing', status: 'Active', price: '$39/mo', description: 'Launch email and social campaigns in minutes.', avatar: '📣' },
  { id: 4, name: 'DesignFlow', category: 'Design', status: 'Inactive', price: '$19/mo', description: 'Collaborative wireframing and prototyping tool.', avatar: '🎨' },
  { id: 5, name: 'PipelineCI', category: 'Engineering', status: 'Active', price: '$59/mo', description: 'Automated CI/CD pipelines for any stack.', avatar: '🔧' },
  { id: 6, name: 'LeadTracker', category: 'Marketing', status: 'Active', price: '$34/mo', description: 'Track and score leads across all touchpoints.', avatar: '🎯' },
  { id: 7, name: 'IconStudio', category: 'Design', status: 'Active', price: '$15/mo', description: 'Create and export pixel-perfect icon sets.', avatar: '✏️' },
  { id: 8, name: 'LogWatcher', category: 'Engineering', status: 'Inactive', price: '$22/mo', description: 'Centralised log aggregation and alerting.', avatar: '🔍' },
  { id: 9, name: 'SEO Booster', category: 'Marketing', status: 'Inactive', price: '$44/mo', description: 'Keyword tracking, audits and competitor analysis.', avatar: '📈' },
  { id: 10, name: 'ComponentLib', category: 'Design', status: 'Active', price: '$25/mo', description: 'Shared UI component library for design systems.', avatar: '🧩' },
  { id: 11, name: 'APIForge', category: 'Engineering', status: 'Active', price: '$49/mo', description: 'Design, mock and test REST and GraphQL APIs.', avatar: '🛠️' },
  { id: 12, name: 'SocialPulse', category: 'Marketing', status: 'Active', price: '$31/mo', description: 'Monitor brand mentions across all social channels.', avatar: '💬' },
]

const CATEGORIES = ['All', 'Design', 'Engineering', 'Marketing'] as const
const STATUSES = ['All', 'Active', 'Inactive'] as const

type CategoryFilter = typeof CATEGORIES[number]
type StatusFilter = typeof STATUSES[number]

const CATEGORY_COLORS: Record<Product['category'], string> = {
  Design: '#8b5cf6',
  Engineering: '#2563eb',
  Marketing: '#d97706',
}

export function HomePage({ navigate }: HomePageProps) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('All')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All')

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return PRODUCTS.filter((p) => {
      const matchSearch = !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
      const matchCat = category === 'All' || p.category === category
      const matchStatus = statusFilter === 'All' || p.status === statusFilter
      return matchSearch && matchCat && matchStatus
    })
  }, [search, category, statusFilter])

  return (
    <div style={styles.page}>
      {/* Nav */}
      <header style={styles.nav}>
        <span style={styles.navLogo}>🚀 Launchpad</span>
        <div style={styles.navRight}>
          <span style={styles.navUser}>admin@example.com</span>
          <button style={styles.signOutBtn} onClick={() => navigate('login')}>
            Sign out
          </button>
        </div>
      </header>

      {/* Main */}
      <main style={styles.main}>
        <div style={styles.toolbar}>
          <input
            style={styles.searchInput}
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={styles.filters}>
            {CATEGORIES.map((c) => (
              <IfExpression condition={false} children={<button
                key={c}
                style={{ ...styles.filterChip, ...(category === c ? styles.filterChipActive : {}) }}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>}>
           
              </IfExpression>
            ))}
            <span style={{ width: 1, background: '#e5e7eb', alignSelf: 'stretch' }} />
            {STATUSES.map((s) => (
              <button
                key={s}
                style={{ ...styles.filterChip, ...(statusFilter === s ? styles.filterChipActive : {}) }}
                onClick={() => setStatusFilter(s)}
              >
                {s}
              </button>
            ))}
          </div>



        </div>

        {filtered.length === 0 ? (
          <div style={styles.empty}>
            <span>No products match your filters.</span>
            <button
              style={styles.clearBtn}
              onClick={() => { setSearch(''); setCategory('All'); setStatusFilter('All') }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div style={styles.grid}>
            {filtered.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

function ProductCard({ product }: { product: Product }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={styles.cardAvatar}>{product.avatar}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={styles.cardName}>{product.name}</p>
          <div style={styles.cardMeta}>
            <span
              style={{
                ...styles.catBadge,
                background: CATEGORY_COLORS[product.category] + '22',
                color: CATEGORY_COLORS[product.category],
              }}
            >
              {product.category}
            </span>
            <span
              style={{
                ...styles.statusDot,
                background: product.status === 'Active' ? '#22c55e' : '#9ca3af',
              }}
            />
            <span
              style={{
                ...styles.statusLabel,
                color: product.status === 'Active' ? '#16a34a' : '#6b7280',
              }}
            >
              {product.status}
            </span>
          </div>
        </div>
        <span style={styles.price}>{product.price}</span>
      </div>
      <p style={styles.cardDesc}>{product.description}</p>
      <div style={styles.cardFooter}>
        <button style={styles.detailBtn}>View details</button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    background: '#f9fafb',
    fontFamily: 'system-ui, sans-serif',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 2rem',
    height: 56,
    background: '#fff',
    borderBottom: '1px solid #e5e7eb',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  navLogo: {
    fontWeight: 700,
    fontSize: '1.1rem',
    color: '#111827',
    letterSpacing: '-0.02em',
  },
  navRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
  },
  navUser: {
    fontSize: '0.85rem',
    color: '#6b7280',
  },
  signOutBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '0.35rem 0.85rem',
    fontSize: '0.85rem',
    cursor: 'pointer',
    color: '#374151',
  },
  main: {
    maxWidth: 1100,
    margin: '0 auto',
    padding: '2rem 1.5rem',
  },
  toolbar: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    marginBottom: '1.5rem',
  },
  searchInput: {
    width: '100%',
    padding: '0.6rem 1rem',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    fontSize: '0.9rem',
    outline: 'none',
    boxSizing: 'border-box',
  },
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
    alignItems: 'center',
  },
  filterChip: {
    background: '#f3f4f6',
    border: '1px solid #e5e7eb',
    borderRadius: 99,
    padding: '0.3rem 0.85rem',
    fontSize: '0.8rem',
    cursor: 'pointer',
    fontWeight: 500,
    transition: 'all 0.12s',
  },
  filterChipActive: {
    background: '#2563eb',
    border: '1px solid #2563eb',
    color: '#fff',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '1rem',
  },
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    transition: 'box-shadow 0.15s',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.75rem',
  },
  cardAvatar: {
    width: 40,
    height: 40,
    borderRadius: 8,
    background: '#f3f4f6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.25rem',
    flexShrink: 0,
  },
  cardName: {
    margin: 0,
    fontWeight: 600,
    fontSize: '0.95rem',
    color: '#111827',
    lineHeight: 1.3,
  },
  cardMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4rem',
    marginTop: '0.25rem',
  },
  catBadge: {
    fontSize: '0.7rem',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 99,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    display: 'inline-block',
  },
  statusLabel: {






    fontSize: '0.75rem',
    fontWeight: 500,
  },
  price: {
    fontSize: '0.85rem',
    fontWeight: 700,
    color: '#111827',
    flexShrink: 0,
  },
  cardDesc: {
    margin: 0,
    fontSize: '0.8rem',
    color: '#6b7280',
    lineHeight: 1.5,
  },
  cardFooter: {
    borderTop: '1px solid #f3f4f6',
    paddingTop: '0.75rem',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  detailBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '0.3rem 0.75rem',
    fontSize: '0.8rem',
    color: '#374151',
    cursor: 'pointer',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '4rem 1rem',
    color: '#6b7280',
    fontSize: '0.9rem',
  },
  clearBtn: {
    marginTop: '0.5rem',
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '0.4rem 1rem',
    fontSize: '0.85rem',
    cursor: 'pointer',
    color: '#2563eb',
  },
}
