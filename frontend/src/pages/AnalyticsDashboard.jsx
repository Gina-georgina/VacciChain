import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../hooks/useFreighter';

const ANALYTICS_BASE = import.meta.env.VITE_ANALYTICS_URL || 'http://localhost:8001';
const REFRESH_INTERVAL = 60_000;

const s = {
  page: { maxWidth: 900, width: '100%', margin: '2rem auto', padding: '0 1rem', boxSizing: 'border-box' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.5rem' },
  h2: { color: '#e2e8f0', margin: 0 },
  refreshInfo: { color: '#64748b', fontSize: '0.8rem' },
  section: { background: '#0f172a', border: '1px solid #1e293b', borderRadius: 10, padding: '1.25rem', marginBottom: '1.5rem' },
  sectionTitle: { color: '#94a3b8', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' },
  error: { color: '#f87171', padding: '0.75rem', background: '#1e293b', borderRadius: 8, marginBottom: '1rem' },
  loading: { color: '#64748b', textAlign: 'center', padding: '2rem 0' },
  sectionError: { color: '#f87171', padding: '0.75rem', background: '#1e293b', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' },
  partialNote: { color: '#fcd34d', fontSize: '0.8rem', marginBottom: '0.75rem' },
  retryBtn: { background: '#0ea5e9', color: '#0f172a', border: 'none', borderRadius: 6, padding: '0.4rem 0.9rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' },
  th: { textAlign: 'left', color: '#64748b', fontWeight: 500, padding: '0.5rem 0.75rem', borderBottom: '1px solid #1e293b' },
  td: { padding: '0.6rem 0.75rem', color: '#e2e8f0', borderBottom: '1px solid #1e293b' },
  badge: (severity) => ({
    display: 'inline-block',
    padding: '0.2rem 0.6rem',
    borderRadius: 4,
    fontSize: '0.75rem',
    fontWeight: 600,
    background: severity === 'high' ? '#7f1d1d' : severity === 'medium' ? '#78350f' : '#1e3a5f',
    color: severity === 'high' ? '#fca5a5' : severity === 'medium' ? '#fcd34d' : '#93c5fd',
  }),
  barWrap: { display: 'flex', flexDirection: 'column', gap: '0.6rem' },
  barRow: { display: 'flex', alignItems: 'center', gap: '0.75rem' },
  barLabel: { color: '#94a3b8', fontSize: '0.85rem', minWidth: 140, textAlign: 'right', flexShrink: 0 },
  barTrack: { flex: 1, background: '#1e293b', borderRadius: 4, height: 18, overflow: 'hidden' },
  barFill: (pct) => ({ width: `${pct}%`, height: '100%', background: '#0ea5e9', borderRadius: 4, transition: 'width 0.4s ease' }),
  barCount: { color: '#e2e8f0', fontSize: '0.85rem', minWidth: 40 },
  noData: { color: '#475569', textAlign: 'center', padding: '1.5rem 0' },
};

function BarChart({ data }) {
  if (!data || data.length === 0) return <p style={s.noData}>No data available.</p>;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div style={s.barWrap} role="list" aria-label="Vaccination rates by vaccine type">
      {data.map((d) => (
        <div key={d.vaccine_name} style={s.barRow} role="listitem">
          <span style={s.barLabel} title={d.vaccine_name}>
            {d.vaccine_name.length > 18 ? d.vaccine_name.slice(0, 17) + '…' : d.vaccine_name}
          </span>
          <div style={s.barTrack} aria-label={`${d.vaccine_name}: ${d.count} doses`}>
            <div style={s.barFill(Math.round((d.count / max) * 100))} />
          </div>
          <span style={s.barCount}>{d.count}</span>
        </div>
      ))}
    </div>
  );
}

function IssuerTable({ data }) {
  if (!data || data.length === 0) return <p style={s.noData}>No issuer activity recorded.</p>;
  return (
    <table style={s.table} aria-label="Issuer activity">
      <thead>
        <tr>
          <th style={s.th}>Issuer</th>
          <th style={s.th}>Volume</th>
          <th style={s.th}>Last Active</th>
        </tr>
      </thead>
      <tbody>
        {data.map((issuer) => (
          <tr key={issuer.address}>
            <td style={s.td} title={issuer.address}>
              {issuer.address.slice(0, 8)}…{issuer.address.slice(-6)}
            </td>
            <td style={s.td}>{issuer.count}</td>
            <td style={s.td}>{issuer.last_active ? new Date(issuer.last_active).toLocaleString() : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AnomalyList({ data }) {
  if (!data || data.length === 0) return <p style={{ ...s.noData, color: '#4ade80' }}>✅ No anomalies detected.</p>;
  return (
    <table style={s.table} aria-label="Anomaly flags">
      <thead>
        <tr>
          <th style={s.th}>Issuer</th>
          <th style={s.th}>Mint Count</th>
          <th style={s.th}>Severity</th>
          <th style={s.th}>Reason</th>
        </tr>
      </thead>
      <tbody>
        {data.map((a, i) => (
          <tr key={i}>
            <td style={s.td} title={a.issuer}>{a.issuer.slice(0, 8)}…{a.issuer.slice(-6)}</td>
            <td style={s.td}>{a.count}</td>
            <td style={s.td}><span style={s.badge(a.severity)}>{a.severity ?? 'medium'}</span></td>
            <td style={s.td}>{a.reason ?? 'Unusual minting volume'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SECTIONS = [
  { key: 'rates', path: '/analytics/rates', field: 'rates' },
  { key: 'issuers', path: '/analytics/issuers', field: 'issuers' },
  { key: 'anomalies', path: '/analytics/anomalies', field: 'anomalies' },
];

const initialSectionState = () => ({
  rates: { status: 'loading', data: null, error: null },
  issuers: { status: 'loading', data: null, error: null },
  anomalies: { status: 'loading', data: null, error: null },
});

export default function AnalyticsDashboard() {
  const { role } = useAuth();
  const [sections, setSections] = useState(initialSectionState);
  const [lastRefresh, setLastRefresh] = useState(null);
  const timerRef = useRef(null);

  const setSection = useCallback((key, patch) => {
    setSections((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }, []);

  const fetchSection = useCallback(async (section) => {
    setSection(section.key, { status: 'loading', error: null });
    try {
      const res = await fetch(`${ANALYTICS_BASE}${section.path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json[section.field] ?? json;
      setSection(section.key, { status: 'success', data, error: null });
    } catch (e) {
      setSection(section.key, {
        status: 'error',
        error: 'Failed to load analytics data. Is the analytics service running?',
      });
    }
  }, [setSection]);

  const fetchAll = useCallback(async () => {
    await Promise.all(SECTIONS.map((section) => fetchSection(section)));
    setLastRefresh(new Date());
  }, [fetchSection]);

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchAll]);

  if (role !== 'issuer') {
    return (
      <div style={s.page}>
        <p style={{ color: '#f87171' }}>Access restricted to authorized issuers.</p>
      </div>
    );
  }

  const sectionEntries = SECTIONS.map((section) => ({ ...section, state: sections[section.key] }));
  const failedCount = sectionEntries.filter((e) => e.state.status === 'error').length;
  const isPartial = failedCount > 0 && failedCount < sectionEntries.length;
  const allFailed = failedCount === sectionEntries.length;

  const renderSection = (section, title, id, renderData) => {
    const { status, data, error } = section.state;
    return (
      <section style={s.section} aria-labelledby={id}>
        <h3 id={id} style={s.sectionTitle}>{title}</h3>
        {status === 'loading' && data == null && <p style={s.loading}>Loading…</p>}
        {status === 'error' && (
          <div style={s.sectionError} role="alert">
            <span>⚠️ {error}</span>
            <button
              type="button"
              style={s.retryBtn}
              onClick={() => fetchSection(section)}
              aria-label={`Retry loading ${title}`}
            >
              Retry
            </button>
          </div>
        )}
        {status !== 'error' && data != null && renderData(data)}
      </section>
    );
  };

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h2 style={s.h2}>📊 Analytics Dashboard</h2>
        <span style={s.refreshInfo} aria-live="polite">
          {lastRefresh ? `Last updated: ${lastRefresh.toLocaleTimeString()} · auto-refreshes every 60s` : 'Loading…'}
        </span>
      </div>

      {isPartial && (
        <p style={s.partialNote} role="status">
          Some analytics data could not be loaded. Showing available sections.
        </p>
      )}

      {allFailed && (
        <div style={s.error} role="alert">
          <span>⚠️ Failed to load analytics data. Is the analytics service running?</span>
          <button type="button" style={s.retryBtn} onClick={fetchAll} aria-label="Retry loading all analytics data">
            Retry all
          </button>
        </div>
      )}

      {renderSection(sectionEntries[0], 'Vaccination Rates by Vaccine Type', 'rates-title', (data) => <BarChart data={data} />)}
      {renderSection(sectionEntries[1], 'Issuer Activity', 'issuers-title', (data) => <IssuerTable data={data} />)}
      {renderSection(sectionEntries[2], 'Anomaly Flags', 'anomalies-title', (data) => <AnomalyList data={data} />)}
    </div>
  );
}
