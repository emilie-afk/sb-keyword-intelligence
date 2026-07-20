// Download helpers — exports keywords as CSV files

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
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Download all ad keywords as a single CSV
// Each row is one keyword with its match type, category, and headlines
export function downloadKeywordsCSV(keywords) {
  const columns = [
    { key: 'category', label: 'Category' },
    { key: 'keyword', label: 'Keyword' },
    { key: 'matchType', label: 'Match Type' },
    { key: 'source', label: 'Source' },
    { key: 'isGapCategory', label: 'Gap Category' },
    { key: 'headlines[0]', label: 'Headline 1' },
    { key: 'headlines[1]', label: 'Headline 2' },
    { key: 'headlines[2]', label: 'Headline 3' },
  ]

  // Flatten headlines array for CSV
  const flatRows = keywords.map(kw => ({
    ...kw,
    'headlines[0]': kw.headlines?.[0] || '',
    'headlines[1]': kw.headlines?.[1] || '',
    'headlines[2]': kw.headlines?.[2] || '',
    isGapCategory: kw.isGapCategory ? 'Yes' : 'No',
  }))

  const csv = toCSV(flatRows, columns)
  const date = new Date().toISOString().split('T')[0]
  downloadFile(csv, `sb-ad-keywords-${date}.csv`, 'text/csv;charset=utf-8;')
}

// Download keywords filtered to a single category
export function downloadCategoryCSV(keywords, category) {
  const filtered = keywords.filter(k => k.category === category)
  downloadKeywordsCSV(filtered)
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
    ctr: q.ctr.toFixed(2),
    position: q.position.toFixed(1),
    buyingIntent: q.buyingIntent ? 'Yes' : 'No',
    isBranded: q.isBranded ? 'Yes' : 'No',
  }))

  const csv = toCSV(flatRows, columns)
  const date = new Date().toISOString().split('T')[0]
  downloadFile(csv, `sb-search-queries-${date}.csv`, 'text/csv;charset=utf-8;')
}
