import { createClient } from '@supabase/supabase-js'

// These are safe to expose — they're the "publishable" keys
// The site is protected by Netlify password, and Supabase RLS adds a second layer
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase environment variables. Check your .env.local file.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Save a full analysis run to Supabase
export async function saveAnalysis({ queries, adKeywords, dateStart, dateEnd, source }) {
  // 1. Create the upload record
  const { data: upload, error: uploadError } = await supabase
    .from('gsc_uploads')
    .insert({
      source,
      date_start: dateStart,
      date_end: dateEnd,
      rows_count: queries.length,
      total_clicks: queries.reduce((sum, q) => sum + q.clicks, 0),
      total_impressions: queries.reduce((sum, q) => sum + q.impressions, 0),
    })
    .select()
    .single()

  if (uploadError) throw uploadError

  const uploadId = upload.id

  // 2. Save all queries in batches of 500 (Supabase limit)
  const batchSize = 500
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize).map(q => ({
      upload_id: uploadId,
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: q.ctr,
      position: q.position,
      category: q.category,
      buying_intent: q.buyingIntent,
      is_branded: q.isBranded,
    }))
    const { error } = await supabase.from('search_queries').insert(batch)
    if (error) throw error
  }

  // 3. Save ad keywords
  if (adKeywords && adKeywords.length > 0) {
    const kwRows = adKeywords.map(kw => ({
      upload_id: uploadId,
      keyword: kw.keyword,
      match_type: kw.matchType,
      category: kw.category,
      headline_1: kw.headlines?.[0] || null,
      headline_2: kw.headlines?.[1] || null,
      headline_3: kw.headlines?.[2] || null,
      source: kw.source,
      is_gap_category: kw.isGapCategory,
    }))
    for (let i = 0; i < kwRows.length; i += batchSize) {
      const { error } = await supabase.from('ad_keywords').insert(kwRows.slice(i, i + batchSize))
      if (error) throw error
    }
  }

  return uploadId
}

// Load past analyses from Supabase
export async function loadHistory() {
  const { data, error } = await supabase
    .from('gsc_uploads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return data
}

// Load queries for a past upload
export async function loadUploadQueries(uploadId) {
  const { data, error } = await supabase
    .from('search_queries')
    .select('*')
    .eq('upload_id', uploadId)
  if (error) throw error
  return data
}

// Load ad keywords for a past upload
export async function loadUploadKeywords(uploadId) {
  const { data, error } = await supabase
    .from('ad_keywords')
    .select('*')
    .eq('upload_id', uploadId)
  if (error) throw error
  return data
}
