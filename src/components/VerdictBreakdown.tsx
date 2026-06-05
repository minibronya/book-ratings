import type { BookRating } from "@/lib/types";

type Props = Pick<
  BookRating,
  "raveCount" | "positiveCount" | "mixedCount" | "panCount"
>;

export function VerdictBreakdown({
  raveCount,
  positiveCount,
  mixedCount,
  panCount,
}: Props) {
  const total = raveCount + positiveCount + mixedCount + panCount;
  if (total === 0) {
    return <span className="breakdownEmpty">—</span>;
  }

  const segments = [
    { key: "rave", count: raveCount, className: "breakdownRave" },
    { key: "positive", count: positiveCount, className: "breakdownPositive" },
    { key: "mixed", count: mixedCount, className: "breakdownMixed" },
    { key: "pan", count: panCount, className: "breakdownPan" },
  ].filter((segment) => segment.count > 0);

  return (
    <div
      className="breakdownBar"
      role="img"
      aria-label={`Critic verdicts: ${raveCount} rave, ${positiveCount} positive, ${mixedCount} mixed, ${panCount} pan`}
    >
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={segment.className}
          style={{ flexGrow: segment.count }}
          title={`${segment.key}: ${segment.count}`}
        />
      ))}
    </div>
  );
}
