// Download helpers — exports keywords as CSV files
import { rowsToCsv } from './workspace.js'

// Convert an array of objects to a CSV string
function toCSV(rows, columns) {
  const header = columns.map(c => `"${c.label}"`).join(',')
  const lines = rows.map(row =>
    columns.map(c => {
      const val = row[c.key] ?? ''
      // Escape quotes and wrap in quotes if the value contains commas or quotes
      const str = String(val).replace(/"/g, '""')
      return `"${str}"`
    }).join(',')
  )
  return [header, ...lines].join('\n')
}

// Trigger a file download in the browser
export function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Download keyword rows (see rowsToCsv in workspace.js for the columns)
export function downloadKeywordRows(rows, label = 'all') {
  const date = new Date().toISOString().split('T')[0]
  const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keywords'
  downloadFile(rowsToCsv(rows), `sb-ad-keywords-${safe}-${date}.csv`, 'text/csv;charset=utf-8;')
}

// Download the analysis query data as CSV
export function downloadQueriesCSV(queries) {
  const columns = [
    { key: 'query', label: 'Query' },
    { key: 'category', label: 'Category' },
    { key: 'clicks', label: 'Clicks' },
    { key: 'impressions', label: 'Impressions' },
    { key: 'ctr', label: 'CTR (%)' },
    { key: 'position', label: 'Position' },
    { key: 'buyingIntent', label: 'Buying Intent' },
    { key: 'isBranded', label: 'Branded' },
  ]

  const flatRows = queries.map(q => ({
    ...q,
    ctr: Number(q.ctr || 0).toFixed(2),
    position: Number(q.position || 0).toFixed(1),
    buyingIntent: q.buyingIntent ? 'Yes' : 'No',
    isBranded: q.isBranded ? 'Yes' : 'No',
  }))

  const csv = toCSV(flatRows, columns)
  const date = new Date().toISOString().split('T')[0]
  downloadFile(csv, `sb-search-queries-${date}.csv`, 'text/csv;charset=utf-8;')
}
