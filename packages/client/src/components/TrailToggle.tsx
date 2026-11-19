import './trailToggle.css';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function TrailToggle({ checked, onChange }: Props) {
  return (
    <div className="trail-toggle">
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-describedby="trail-toggle-hint"
        />
        Show short trails for all aircraft
      </label>
      <p id="trail-toggle-hint">Select an aircraft to see up to 10 minutes of its estimated track.</p>
    </div>
  );
}
