"use client";

type Props = {
  min: number;
  max: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  disabled?: boolean;
};

export function YearRangeSlider({ min, max, value, onChange, disabled }: Props) {
  const [low, high] = value;
  const span = Math.max(max - min, 1);
  const lowPct = ((low - min) / span) * 100;
  const highPct = ((high - min) / span) * 100;

  return (
    <div className={`yearSlider${disabled ? " disabled" : ""}`}>
      <div className="yearSliderLabel">
        <span>Year range</span>
        <span>{low === high ? low : `${low} – ${high}`}</span>
      </div>
      <div className="yearSliderTrack">
        <div
          className="yearSliderFill"
          style={{ left: `${lowPct}%`, right: `${100 - highPct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          value={low}
          disabled={disabled}
          aria-label="Earliest year"
          onChange={(event) =>
            onChange([Math.min(Number(event.target.value), high), high])
          }
        />
        <input
          type="range"
          min={min}
          max={max}
          value={high}
          disabled={disabled}
          aria-label="Latest year"
          onChange={(event) =>
            onChange([low, Math.max(Number(event.target.value), low)])
          }
        />
      </div>
    </div>
  );
}
