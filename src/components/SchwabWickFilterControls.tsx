import { useEffect, useState } from "react";
import type { SchwabWickFilterSettings } from "../types";
import { normalizeSchwabWickFilter } from "../lib/schwabWickFilter";

export function SchwabWickFilterControls({ settings, onChange }: {
  settings: SchwabWickFilterSettings;
  onChange: (settings: SchwabWickFilterSettings) => void;
}) {
  const [draft, setDraft] = useState(settings.maxWickPercent.toFixed(2));
  useEffect(() => setDraft(settings.maxWickPercent.toFixed(2)), [settings.maxWickPercent]);

  const saveThreshold = () => {
    const next = normalizeSchwabWickFilter({ ...settings, maxWickPercent: draft.trim() ? Number(draft) : Number.NaN }, settings);
    setDraft(next.maxWickPercent.toFixed(2));
    if (next.maxWickPercent !== settings.maxWickPercent) onChange(next);
  };

  return <section className="chart-session-settings wick-filter-settings" aria-labelledby="wick-filter-heading">
    <header>
      <span>Schwab equities &amp; ETFs</span>
      <h3 id="wick-filter-heading">Extended-hours wick filter</h3>
      <p>Trim extreme highs and lows on all Schwab stock charts. Candle bodies and volume remain intact. Candles overlapping regular hours are preserved.</p>
    </header>
    <label className="switch-row settings-row">
      <span><strong>Filter extended-hours wicks</strong><small>Applies to intraday charts and chart studies</small></span>
      <input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
    </label>
    <label className="wick-filter-threshold">
      <span><strong>Maximum wick beyond body</strong><small>Lower values trim more aggressively</small></span>
      <span className="wick-filter-value"><input type="number" min="0.01" max="5" step="0.01" aria-label="Maximum wick beyond body (%)" disabled={!settings.enabled}
        value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={saveThreshold}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>%</span></span>
    </label>
    <p className="session-settings-note">A price-based filter for suspected outliers; it cannot identify individual late trades. At $770, 0.10% allows about $0.77 beyond each body edge.</p>
  </section>;
}
