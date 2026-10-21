import { CATEGORIES } from '../shared/keywordRules'

const price = (min, max) => (min == null ? '' : min === max || max == null ? `$${min.toFixed(2)}` : `$${min.toFixed(2)} – $${max.toFixed(2)}`)

// Preview of a loaded collection/product page + ad group settings, shown before generation
export default function PagePreview({
  page, selected, setSelected, groupName, setGroupName, groupCategory, setGroupCategory,
  existingGroup, onConfirm, busy, needsDataset,
}) {
  const isCollection = page.type === 'collection'
  const products = page.products || []
  const noneSelected = isCollection && products.length > 0 && selected.size === 0

  return (
    <div className="preview-card">
      <div className="preview-head">
        {page.image && <img className="preview-img" src={page.image} alt="" />}
        <div style={{ minWidth: 0 }}>
          <div className="preview-kicker">{isCollection ? 'Collection' : 'Product'} · <a href={page.url} target="_blank" rel="noreferrer">{page.url.replace('https://', '')}</a></div>
          <h2 className="preview-title">{page.title}</h2>
          {!isCollection && (
            <div className="preview-meta">
              {price(page.priceMin, page.priceMax)}
              {page.productType ? ` · ${page.productType}` : ''}
              {page.available === false ? ' · Sold out' : ''}
            </div>
          )}
          {page.description
            ? <p className="preview-desc">{page.description}</p>
            : <p className="preview-desc muted">No description on this page.</p>}
        </div>
      </div>

      {!isCollection && (
        <div className="preview-grid">
          <div>
            <div className="preview-label">Variants</div>
            {page.variants?.length ? (
              <table className="mini-table">
                <tbody>
                  {page.variants.map((v, i) => (
                    <tr key={i}>
                      <td>{v.title}</td>
                      <td className="num">{v.price != null ? `$${v.price.toFixed(2)}` : '—'}</td>
                      <td>{v.available ? '' : <span className="badge badge-gap">Sold out</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">—</p>}
          </div>
          <div>
            <div className="preview-label">Contents / details listed on the page</div>
            {page.details?.length
              ? <ul className="detail-list">{page.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
              : <p className="muted">No itemized contents listed.</p>}
          </div>
        </div>
      )}

      {isCollection && (
        <div>
          <div className="preview-toolbar">
            <span className="preview-label" style={{ margin: 0 }}>
              Products — {selected.size} of {products.length} selected
              {page.productsCount > products.length ? ` (store reports ${page.productsCount})` : ''}
            </span>
            <button className="btn-secondary btn-sm" onClick={() => setSelected(new Set(products.map(p => p.handle)))}>Select all</button>
            <button className="btn-secondary btn-sm" onClick={() => setSelected(new Set())}>Clear all</button>
          </div>
          {page.truncated && <p className="cta-hint" style={{ margin: '0 0 8px' }}>Large collection — only the first {products.length} products were loaded.</p>}
          {products.length === 0
            ? <div className="alert-gap">This collection has no published products. Keywords will be based on the collection title and description only.</div>
            : (
              <div className="product-list">
                {products.map(p => (
                  <label key={p.handle} className="product-row">
                    <input
                      type="checkbox"
                      checked={selected.has(p.handle)}
                      onChange={e => {
                        const next = new Set(selected)
                        e.target.checked ? next.add(p.handle) : next.delete(p.handle)
                        setSelected(next)
                      }}
                    />
                    {p.image ? <img className="thumb" src={p.image} alt="" loading="lazy" /> : <span className="thumb" />}
                    <span className="product-name">{p.title}</span>
                    <span className="product-price">{price(p.priceMin, p.priceMax)}{p.available ? '' : ' · sold out'}</span>
                  </label>
                ))}
              </div>
            )}
        </div>
      )}

      <div className="preview-footer">
        <label className="field">
          <span>Ad group name</span>
          <input className="input" value={groupName} onChange={e => setGroupName(e.target.value)} />
        </label>
        <label className="field">
          <span>Category</span>
          <select className="input" value={groupCategory} onChange={e => setGroupCategory(e.target.value)}>
            {[...CATEGORIES, 'Other'].map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span>Landing page</span>
          <input className="input" value={page.url} readOnly />
        </label>
        <button className="btn-primary" onClick={onConfirm} disabled={busy || needsDataset || noneSelected || !groupName.trim()}>
          {busy ? 'Working…' : existingGroup ? 'Update ad group & find GSC evidence' : 'Add ad group & find GSC evidence'}
        </button>
      </div>
      {noneSelected && <p className="cta-hint" style={{ textAlign: 'right' }}>Select at least one product.</p>}
      {needsDataset && <p className="cta-hint" style={{ textAlign: 'right' }}>Preview only — load a GSC dataset to find evidence and generate keywords for this page.</p>}
    </div>
  )
}
