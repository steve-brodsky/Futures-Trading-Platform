import { useEffect, useMemo, useRef, useState } from "react";
import { Save, Trash2, X } from "lucide-react";
import { validateCustomMinuteInput } from "../lib/timeframes";

export interface CustomTimeframeEntry {
  minutes: number;
  saved: boolean;
}

interface CustomTimeframeModalProps {
  entries: CustomTimeframeEntry[];
  onAdd: (minutes: number, save: boolean) => void;
  onPromote: (minutes: number) => void;
  onRemove: (minutes: number) => void;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}

export function CustomTimeframeModal({ entries, onAdd, onPromote, onRemove, onClose, returnFocusRef }: CustomTimeframeModalProps) {
  const [value, setValue] = useState("");
  const [save, setSave] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const validation = useMemo(() => validateCustomMinuteInput(value, entries.map((entry) => entry.minutes)), [value, entries]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [returnFocusRef]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (validation.minutes == null) return;
    onAdd(validation.minutes, save);
  }

  return <div className="modal-backdrop custom-timeframe-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal custom-timeframe-modal" role="dialog" aria-modal="true" aria-labelledby="custom-timeframe-title" aria-describedby="custom-timeframe-description">
      <header><h2 id="custom-timeframe-title">Custom timeframe</h2><button className="icon-button" type="button" aria-label="Close custom timeframe" onClick={onClose}><X size={17} /></button></header>
      <form onSubmit={submit} noValidate>
        <p id="custom-timeframe-description">Add a chart interval from 1 to 1,440 minutes.</p>
        <label className="custom-timeframe-input-label" htmlFor="custom-timeframe-minutes">Minutes</label>
        <div className={`custom-timeframe-input ${submitted && validation.error ? "invalid" : ""}`}>
          <input ref={inputRef} id="custom-timeframe-minutes" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" placeholder="45" value={value} aria-invalid={submitted && validation.error ? true : undefined} aria-describedby={submitted && validation.error ? "custom-timeframe-error" : undefined} onChange={(event) => { setValue(event.target.value); setSubmitted(false); }} />
          <span>MIN</span>
        </div>
        <div className="custom-timeframe-message" aria-live="polite">{submitted && validation.error ? <span id="custom-timeframe-error">{validation.error}</span> : <span>Whole numbers only</span>}</div>
        <label className="custom-timeframe-save"><input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} /><span><strong>Save timeframe</strong><small>Sync it with chart preferences.</small></span></label>
        <button className="primary-button custom-timeframe-add" type="submit">Add timeframe</button>
      </form>
      {entries.length > 0 && <div className="custom-timeframe-existing">
        <header><strong>Custom intervals</strong><span>{entries.length}</span></header>
        <div>{entries.map((entry) => <div className="custom-timeframe-row" key={entry.minutes}>
          <span><strong>{entry.minutes}m</strong><small>{entry.saved ? "Saved" : "Session"}</small></span>
          <div>{!entry.saved && <button type="button" title={`Save ${entry.minutes} minute timeframe`} aria-label={`Save ${entry.minutes} minute timeframe`} onClick={() => onPromote(entry.minutes)}><Save size={13} /></button>}<button className="danger" type="button" title={`Remove ${entry.minutes} minute timeframe`} aria-label={`Remove ${entry.minutes} minute timeframe`} onClick={() => onRemove(entry.minutes)}><Trash2 size={13} /></button></div>
        </div>)}</div>
      </div>}
    </section>
  </div>;
}
