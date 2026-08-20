"use client";

/**
 * Inline SVG charts. No chart library: four shapes, each drawn to say one thing.
 */

export interface Rung {
  readonly payoff: number;
  readonly probability: number;
}

/**
 * The payoff ladder — the whole reason an index is not a coin flip.
 *
 * A single contract has two bars: nothing, or everything. N legs have N+1, and
 * the mass piles up in the middle. The cost line is drawn on top because the
 * bars to its right are the ones that made money.
 */
export function PayoffLadder({
  rungs,
  cost,
  fair,
  height = 168,
}: {
  rungs: readonly Rung[];
  cost: number | null;
  fair: number;
  height?: number;
}) {
  const width = 560;
  const pad = { left: 8, right: 8, top: 12, bottom: 26 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const peak = Math.max(...rungs.map((r) => r.probability), 0.0001);
  const barWidth = Math.max(3, Math.min(46, plotWidth / Math.max(1, rungs.length) - 6));
  const x = (payoff: number) => pad.left + payoff * plotWidth;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
      aria-label="Probability of each payoff level">
      <line x1={pad.left} y1={pad.top + plotHeight} x2={width - pad.right} y2={pad.top + plotHeight}
        stroke="var(--line)" />
      {rungs.map((rung) => {
        const barHeight = (rung.probability / peak) * plotHeight;
        const profitable = cost !== null && rung.payoff > cost;
        return (
          <g key={rung.payoff}>
            <rect
              x={x(rung.payoff) - barWidth / 2}
              y={pad.top + plotHeight - barHeight}
              width={barWidth}
              height={barHeight}
              rx={2}
              fill={profitable ? "var(--up)" : "var(--down)"}
              opacity={profitable ? 0.82 : 0.5}
            />
            {rung.probability > 0.03 && (
              <text x={x(rung.payoff)} y={pad.top + plotHeight - barHeight - 4} textAnchor="middle"
                fontSize="9.5" fill="var(--muted)" fontFamily="var(--mono)">
                {(rung.probability * 100).toFixed(0)}%
              </text>
            )}
          </g>
        );
      })}
      {cost !== null && (
        <g>
          <line x1={x(cost)} y1={pad.top - 4} x2={x(cost)} y2={pad.top + plotHeight}
            stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="3 3" />
          <text x={x(cost)} y={pad.top + plotHeight + 15} textAnchor="middle" fontSize="10"
            fill="var(--accent)" fontFamily="var(--mono)">
            cost {cost.toFixed(3)}
          </text>
        </g>
      )}
      <text x={pad.left} y={pad.top + plotHeight + 15} fontSize="10" fill="var(--dim)"
        fontFamily="var(--mono)">
        pays 0
      </text>
      <text x={width - pad.right} y={pad.top + plotHeight + 15} textAnchor="end" fontSize="10"
        fill="var(--dim)" fontFamily="var(--mono)">
        pays 1 · fair {fair.toFixed(3)}
      </text>
    </svg>
  );
}

/** Risk, as bars. One contract against the basket against the basket rolled. */
export function RiskBars({
  bars,
}: {
  bars: readonly { label: string; sd: number; tone: "base" | "good" | "best" | "hollow" }[];
}) {
  const peak = Math.max(...bars.map((b) => b.sd), 0.0001);
  const colors = { base: "var(--down)", good: "var(--cool)", best: "var(--up)", hollow: "var(--dim)" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {bars.map((bar) => (
        <div key={bar.label}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
            <span style={{ color: "var(--muted)" }}>{bar.label}</span>
            <span style={{ fontFamily: "var(--mono)", color: colors[bar.tone] }}>{bar.sd.toFixed(3)}</span>
          </div>
          <div style={{ height: 8, background: "var(--line-soft)", borderRadius: 4, overflow: "hidden" }}>
            <div style={{
              width: `${(bar.sd / peak) * 100}%`, height: "100%", borderRadius: 4,
              background: colors[bar.tone], opacity: bar.tone === "hollow" ? 0.4 : 0.85,
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Two cumulative-profit paths over the same settled windows. */
export function EquityCurves({
  index,
  single,
  height = 190,
}: {
  index: readonly number[];
  single: readonly number[];
  height?: number;
}) {
  const width = 560;
  const pad = { left: 40, right: 10, top: 12, bottom: 22 };
  const n = Math.max(index.length, single.length);
  if (n < 2) return <p className="dim">Not enough settled windows to replay yet.</p>;

  const all = [...index, ...single, 0];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (i / (n - 1)) * plotWidth;
  const y = (v: number) => pad.top + plotHeight - ((v - lo) / span) * plotHeight;
  const path = (series: readonly number[]) =>
    series.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
      aria-label="Cumulative profit of the index against a single contract">
      <line x1={pad.left} y1={y(0)} x2={width - pad.right} y2={y(0)} stroke="var(--line)" strokeDasharray="2 3" />
      <text x={pad.left - 6} y={y(0) + 3} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">0</text>
      <text x={pad.left - 6} y={y(hi) + 3} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">{hi.toFixed(1)}</text>
      <text x={pad.left - 6} y={y(lo) + 3} textAnchor="end" fontSize="10" fill="var(--dim)" fontFamily="var(--mono)">{lo.toFixed(1)}</text>
      <path d={path(single)} fill="none" stroke="var(--down)" strokeWidth="1.3" opacity="0.85" />
      <path d={path(index)} fill="none" stroke="var(--up)" strokeWidth="1.8" />
      <text x={width - pad.right} y={height - 6} textAnchor="end" fontSize="10" fill="var(--dim)"
        fontFamily="var(--mono)">{n} settled windows</text>
    </svg>
  );
}

/** Measured correlation between every pair of series with a live window. */
export function CorrelationGrid({
  keys,
  rho,
  n,
}: {
  keys: readonly string[];
  rho: readonly (readonly (number | null)[])[];
  n: readonly (readonly number[])[];
}) {
  if (keys.length === 0) return <p className="dim">No series has enough settled windows yet.</p>;
  const shade = (value: number | null) => {
    if (value === null) return "var(--line-soft)";
    // One ramp for agreement, another for disagreement; zero is nearly invisible,
    // which is exactly how independence should read.
    const magnitude = Math.min(1, Math.abs(value));
    const hue = value >= 0 ? "var(--down)" : "var(--cool)";
    return `color-mix(in srgb, ${hue} ${(magnitude * 78).toFixed(0)}%, var(--panel-2))`;
  };

  return (
    <div className="scroller">
      <table>
        <thead>
          <tr>
            <th />
            {keys.map((key) => (
              <th key={key} style={{ textAlign: "center", fontFamily: "var(--mono)", textTransform: "none" }}>
                {key.replace("|", " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((rowKey, i) => (
            <tr key={rowKey}>
              <td className="series">{rowKey.replace("|", " ")}</td>
              {keys.map((colKey, j) => (
                <td key={colKey} title={`${n[i]?.[j] ?? 0} paired windows`}
                  style={{ background: shade(rho[i]?.[j] ?? null), textAlign: "center", fontFamily: "var(--mono)", fontSize: 12 }}>
                  {rho[i]?.[j] === null || rho[i]?.[j] === undefined ? "—" : (rho[i][j] as number).toFixed(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
