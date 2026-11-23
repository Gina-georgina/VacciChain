import AccessibleDialog from './AccessibleDialog';

const row = { display: 'flex', justifyContent: 'space-between', margin: '0.4rem 0', fontSize: '0.9rem' };
const btnRow = { display: 'flex', gap: '0.75rem', marginTop: '1.5rem' };
const btnConfirm = { flex: 1, padding: '0.7rem', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' };
const btnCancel = { flex: 1, padding: '0.7rem', background: 'transparent', color: '#94a3b8', border: '1px solid #334155', borderRadius: 8, fontSize: '1rem', cursor: 'pointer' };

export default function ConfirmMintDialog({ record, onConfirm, onCancel }) {
  return (
    <AccessibleDialog title="Confirm Vaccination Mint" onClose={onCancel}>
      <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '1rem' }}>
        This action is irreversible. Please review the record before confirming.
      </p>
      <div style={{ background: '#0f172a', borderRadius: 8, padding: '0.75rem 1rem' }}>
        <div style={row}><span style={{ color: '#64748b' }}>Patient</span><span style={{ wordBreak: 'break-all', maxWidth: '60%', textAlign: 'right' }}>{record.patient_address}</span></div>
        <div style={row}><span style={{ color: '#64748b' }}>Vaccine</span><span>{record.vaccine_name}</span></div>
        <div style={row}><span style={{ color: '#64748b' }}>Date</span><span>{record.date_administered}</span></div>
      </div>
      <div style={btnRow}>
        <button style={btnCancel} onClick={onCancel}>Cancel</button>
        <button style={btnConfirm} onClick={onConfirm}>Confirm &amp; Mint</button>
      </div>
    </AccessibleDialog>
  );
}
