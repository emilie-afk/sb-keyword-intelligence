import { useEffect, useState } from 'react'
import { api } from '../lib/api'

// Owner-only: approve / revoke members and manage prompt versions.
// The page is only shown to the owner, but every action is authorized again by the server and the database.
const STATUS_LABELS = { approved: 'Approved', pending: 'Waiting for approval', revoked: 'Revoked' }

export default function TeamPage({ ownerEmail }) {
  return (
    <div className="page">
      <h2 style={{ marginTop: 0 }}>Team</h2>
      <Members ownerEmail={ownerEmail} />
      <Prompts />
    </div>
  )
}

function Members({ ownerEmail }) {
  const [members, setMembers] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [newEmail, setNewEmail] = useState('')

  const load = async () => {
    try {
      setMembers((await api.members({ op: 'list' })).members)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }
  useEffect(() => { load() }, [])

  const act = async (payload) => {
    setBusy(true)
    try {
      await api.members(payload)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" style={{ marginBottom: 24 }}>
      <h3 style={{ marginTop: 0 }}>Members</h3>
      <p className="cta-hint" style={{ margin: '0 0 12px' }}>
        People who sign in with Google appear here as “Waiting for approval”. You can also approve an email before that person signs in.
      </p>
      {error && <div className="error-box">{error}</div>}
      <table className="data-table team-table">
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Signed in</th><th /></tr></thead>
        <tbody>
          {members.map(m => (
            <tr key={m.email}>
              <td>{m.email}</td>
              <td>{m.role === 'owner' ? 'Owner' : 'Member'}</td>
              <td>{STATUS_LABELS[m.status] || m.status}</td>
              <td>{m.signed_in ? 'Yes' : 'Not yet'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {m.role === 'owner' ? <span className="cta-hint" style={{ margin: 0 }}>{m.email === ownerEmail ? 'You' : 'Owner'}</span> : (
                  <>
                    {m.status !== 'approved' && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act({ op: 'set', email: m.email, status: 'approved' })}>Approve</button>}
                    {m.status === 'approved' && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => act({ op: 'set', email: m.email, status: 'revoked' })}>Revoke</button>}
                    {m.status === 'pending' && <button className="btn-ghost" disabled={busy} onClick={() => act({ op: 'set', email: m.email, status: 'revoked' })}>Decline</button>}
                    {/* Removing a linked account would let it request access again — revoke/decline blocks it */}
                    {!m.signed_in && <button className="btn-ghost" disabled={busy} onClick={() => act({ op: 'remove', email: m.email })}>Remove</button>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {members.filter(m => m.status === 'pending').length > 5 && (
        <button className="btn-ghost" disabled={busy} onClick={() => act({ op: 'clear_pending' })}>Discard all {members.filter(m => m.status === 'pending').length} waiting requests</button>
      )}
      <form style={{ display: 'flex', gap: 8, marginTop: 12 }} onSubmit={e => { e.preventDefault(); if (newEmail.trim()) act({ op: 'set', email: newEmail.trim(), status: 'approved' }).then(() => setNewEmail('')) }}>
        <input className="input" type="email" placeholder="name@company.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} aria-label="Email to approve" />
        <button className="btn-primary btn-sm-primary" disabled={busy || !newEmail.trim()}>Approve email</button>
      </form>
    </section>
  )
}

function Prompts() {
  const [versions, setVersions] = useState([])
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [activate, setActivate] = useState(true)

  const load = async () => {
    try {
      setVersions((await api.prompts({ op: 'list' })).versions)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }
  useEffect(() => { load() }, [])

  const run = async (fn) => {
    setBusy(true)
    setNotice(null)
    try { await fn(); await load() } catch (err) { setError(err.message) } finally { setBusy(false) }
  }
  const open = version => run(async () => {
    const row = await api.prompts({ op: 'get', version })
    setDraft(JSON.stringify(row.config, null, 2))
    setNote(`Based on version ${version}`)
  })
  const save = () => run(async () => {
    let config
    try { config = JSON.parse(draft) } catch { throw new Error('The prompt configuration is not valid JSON.') }
    const { version } = await api.prompts({ op: 'create', config, note, activate })
    setNotice(`Saved as version ${version}${activate ? ' and activated' : ''}.`)
  })

  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Prompts</h3>
      <p className="cta-hint" style={{ margin: '0 0 12px' }}>
        Generation uses the active version. Versions can't be edited: changes are saved as a new version, and you can switch back to any earlier version.
      </p>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="status-success" style={{ marginBottom: 8 }}>{notice}</div>}
      {versions.length === 0 && !error && <div className="hint-bad">No prompt configuration is stored yet — keyword generation is unavailable until one is imported.</div>}
      <table className="data-table team-table">
        <thead><tr><th>Version</th><th>Note</th><th>Created</th><th>Status</th><th /></tr></thead>
        <tbody>
          {versions.map(v => (
            <tr key={v.version}>
              <td>{v.version}</td>
              <td>{v.note || ''}</td>
              <td>{v.created_at ? new Date(v.created_at).toLocaleString() : ''}</td>
              <td>{v.is_active ? 'Active' : ''}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn-ghost" disabled={busy} onClick={() => open(v.version)}>Open</button>
                {!v.is_active && <button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { await api.prompts({ op: 'activate', version: v.version }); setNotice(`Version ${v.version} is now active.`) })}>Activate</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 12 }}>
        <textarea className="input" style={{ width: '100%', minHeight: 220, fontFamily: 'monospace', fontSize: 12 }} value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="Open a version to edit a copy of it, or paste a prompt configuration (JSON)." aria-label="Prompt configuration" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input className="input" placeholder="Note (what changed)" value={note} onChange={e => setNote(e.target.value)} aria-label="Version note" />
          <label style={{ fontSize: 13, whiteSpace: 'nowrap' }}><input type="checkbox" checked={activate} onChange={e => setActivate(e.target.checked)} /> Activate</label>
          <button className="btn-primary btn-sm-primary" disabled={busy || !draft.trim()} onClick={save}>Save as new version</button>
        </div>
      </div>
    </section>
  )
}
