import { useState } from 'react';

interface Props {
  workoutName: string;
  initialFtp: number | null;
  onSubmit: (ftp: number) => void;
  onCancel: () => void;
}

export function FtpModal({ workoutName, initialFtp, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(initialFtp ? String(initialFtp) : '');
  const ftp = Number(value);
  const valid = Number.isFinite(ftp) && ftp >= 50 && ftp <= 600;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ftp-title">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(Math.round(ftp));
        }}
      >
        <h2 id="ftp-title">What's your FTP?</h2>
        <p>
          <strong>{workoutName}</strong> sets power in watts and doesn't include an FTP. RideReel needs your FTP to work out
          which zone each part is in.
        </p>
        <label className="field">
          <span>FTP (watts)</span>
          <input autoFocus type="number" min={50} max={600} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Use this FTP
          </button>
        </div>
      </form>
    </div>
  );
}
