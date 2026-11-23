import { useMemo } from "react";
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Row } from "../api";
import { MAX_SERIES, type Metric, OTHER, type Theme, formatAxis, formatCompact, formatValue, percent, shape, truncate, useStableSlots } from "../lib";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-03" -> "Mar 26", "2026-03-09" -> "9 Mar", everything else unchanged. */
export function formatBucket(v: string): string {
  let m = /^(\d{4})-(\d{2})$/.exec(v);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  return v;
}

/** Round axis ticks from zero: 0 / 1,000 / 2,000 rather than 0 / 950 / 1,900. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, ([1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow);
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

interface ChartProps {
  rows: Row[];
  metric: Metric;
  currency: string;
  /** Used to keep series colours stable; change it when the split dimension changes. */
  scope: string;
  time: boolean;
  split: boolean;
  topN: number;
  theme: Theme;
  seriesLabel: string;
  height?: number;
}

function TooltipBody({ active, payload, label, metric, currency, time, total }: any) {
  if (!active || !payload?.length) return null;
  const items = [...payload].filter((p: any) => p.type !== "none" && Number(p.value) > 0).sort((a: any, b: any) => b.value - a.value);
  if (!items.length) return null;
  const sum = items.reduce((a: number, p: any) => a + Number(p.value), 0);
  const single = items.length === 1 && payload.length === 1;
  return (
    <div className="tip">
      <div className="tip-title">{time ? formatBucket(String(label)) : String(label)}</div>
      {items.map((p: any) => (
        <div className="tip-row" key={p.dataKey}>
          <span className="tip-key" style={{ background: p.color }} />
          <strong>{formatValue(p.value, metric, currency)}</strong>
          <span className="tip-name">{single ? (time ? p.name : percent(p.value, total) + " of total") : p.name}</span>
        </div>
      ))}
      {!single && items.length > 1 && (
        <div className="tip-row tip-sum">
          <span className="tip-key" />
          <strong>{formatValue(sum, metric, currency)}</strong>
          <span className="tip-name">Total</span>
        </div>
      )}
    </div>
  );
}

export function ReportChart({ rows, metric, currency, scope, time, split, topN, theme, seriesLabel, height }: ChartProps) {
  const shaped = useMemo(() => shape(rows, metric, { time, split, topN }), [rows, metric, time, split, topN]);
  const named = shaped.series.filter((s) => s !== OTHER);
  const slots = useStableSlots(scope, split ? named : []);
  const colour = (s: string) => (s === OTHER ? theme.other : split ? theme.series[(slots.get(s) ?? 0) % theme.series.length] : theme.series[0]);
  const label = (s: string) => (split ? s : seriesLabel);
  const tick = { fill: theme.muted, fontSize: 12 };
  // Stacked bars are read against their total; lines and plain bars against the largest single value.
  const peak = Math.max(0, ...shaped.data.map((d) => (split && !time ? shaped.series.reduce((a, k) => a + Number(d[k]), 0) : Math.max(...shaped.series.map((k) => Number(d[k]))))));
  const ticks = niceTicks(peak, time ? 4 : 5);
  const domain: [number, number] = [0, ticks[ticks.length - 1]];
  const tooltip = (
    <Tooltip
      content={(p: any) => <TooltipBody {...p} metric={metric} currency={currency} time={time} total={shaped.total} />}
      cursor={time ? { stroke: theme.axis, strokeWidth: 1 } : { fill: theme.dark ? "rgba(255,255,255,0.05)" : "rgba(11,11,11,0.04)", stroke: "none" }}
      isAnimationActive={false}
    />
  );

  if (!shaped.data.length) return <div className="empty">No matching sales for these filters.</div>;

  const legend = split && (
    <div className="legend">
      {shaped.series.map((s) => (
        <span key={s} className="legend-item" title={s}>
          <span className={time ? "legend-line" : "legend-box"} style={{ background: colour(s) }} />
          {truncate(s, 32)}
        </span>
      ))}
    </div>
  );

  if (time) {
    return (
      <div>
        {legend}
        <ResponsiveContainer width="100%" height={height ?? 320}>
          <ComposedChart data={shaped.data} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={theme.grid} />
            <XAxis dataKey="name" tickFormatter={formatBucket} tick={tick} tickLine={false} axisLine={{ stroke: theme.axis }} minTickGap={28} />
            <YAxis tickFormatter={formatAxis} tick={tick} tickLine={false} axisLine={false} width={52} ticks={ticks} domain={domain} />
            {tooltip}
            {!split && <Area dataKey="value" type="linear" stroke="none" fill={theme.series[0]} fillOpacity={0.1} isAnimationActive={false} tooltipType="none" legendType="none" />}
            {shaped.series.map((s) => (
              <Line
                key={s}
                dataKey={s}
                name={label(s)}
                type="linear"
                stroke={colour(s)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={shaped.data.length === 1 ? { r: 4, fill: colour(s), stroke: theme.surface, strokeWidth: 2 } : false}
                activeDot={{ r: 5, fill: colour(s), stroke: theme.surface, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const longest = Math.max(...shaped.data.map((d) => String(d.name).length));
  const labelWidth = Math.min(250, Math.max(70, Math.min(longest, 30) * 7.4 + 20));
  return (
    <div>
      {legend}
      <ResponsiveContainer width="100%" height={height ?? shaped.data.length * 34 + 48}>
        <BarChart data={shaped.data} layout="vertical" margin={{ top: 4, right: split ? 16 : 64, bottom: 0, left: 0 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke={theme.grid} />
          <XAxis type="number" tickFormatter={formatAxis} tick={tick} tickLine={false} axisLine={false} ticks={ticks} domain={domain} />
          <YAxis
            type="category"
            dataKey="name"
            width={labelWidth}
            tick={{ fill: theme.textSecondary, fontSize: 12 }}
            tickFormatter={(v: string) => truncate(String(v), 30)}
            tickLine={false}
            axisLine={{ stroke: theme.axis }}
            interval={0}
          />
          {tooltip}
          {shaped.series.map((s) => (
            <Bar
              key={s}
              dataKey={s}
              name={label(s)}
              stackId={split ? "stack" : undefined}
              fill={colour(s)}
              stroke={split ? theme.surface : undefined}
              strokeWidth={split ? 2 : 0}
              maxBarSize={24}
              radius={split ? 0 : [0, 4, 4, 0]}
              isAnimationActive={false}
            >
              {!split && (
                <LabelList dataKey={s} position="right" fill={theme.textSecondary} fontSize={12} formatter={(v: any) => formatCompact(Number(v), metric, currency)} />
              )}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
      {shaped.foldedGroups > 0 && <p className="hint">“Other” combines the remaining {shaped.foldedGroups} values. Raise “Show top” or use the table to see them all.</p>}
    </div>
  );
}

/** Rows x columns grid shaded by value: how often each pair of values is sold together. */
export function Heatmap({ rows, metric, currency, topN, theme }: { rows: Row[]; metric: Metric; currency: string; topN: number; theme: Theme }) {
  const { rowNames, colNames, cell, max, rowTotals, colTotals } = useMemo(() => {
    const r = new Map<string, number>();
    const c = new Map<string, number>();
    const cell = new Map<string, number>();
    for (const x of rows) {
      const v = Number(x[metric]) || 0;
      r.set(x.g1 ?? "", (r.get(x.g1 ?? "") ?? 0) + v);
      c.set(x.g2 ?? "", (c.get(x.g2 ?? "") ?? 0) + v);
      cell.set(`${x.g1}\u0000${x.g2}`, v);
    }
    const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
    const rowNames = top(r, topN);
    const colNames = top(c, MAX_SERIES + 3);
    let max = 0;
    for (const a of rowNames) for (const b of colNames) max = Math.max(max, cell.get(`${a}\u0000${b}`) ?? 0);
    return { rowNames, colNames, cell, max, rowTotals: r, colTotals: c };
  }, [rows, metric, topN]);

  if (!rowNames.length) return <div className="empty">No matching sales for these filters.</div>;
  const shade = (v: number) => {
    if (!v || !max) return undefined;
    const i = Math.min(theme.ramp.length - 1, Math.floor((v / max) * (theme.ramp.length - 1)));
    const lightText = theme.dark ? i >= 3 : i >= 6;
    return { background: theme.ramp[i], color: lightText ? "#ffffff" : "#0b0b0b" };
  };
  return (
    <div className="table-wrap">
      <table className="heatmap">
        <thead>
          <tr>
            <th />
            {colNames.map((c) => (
              <th key={c} title={c}>
                {truncate(c, 18)}
              </th>
            ))}
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rowNames.map((r) => (
            <tr key={r}>
              <th title={r}>{truncate(r, 30)}</th>
              {colNames.map((c) => {
                const v = cell.get(`${r}\u0000${c}`) ?? 0;
                return (
                  <td key={c} style={shade(v)} title={`${r} + ${c}: ${formatValue(v, metric, currency)}`}>
                    {v ? formatCompact(v, metric, currency) : ""}
                  </td>
                );
              })}
              <td className="num total">{formatCompact(rowTotals.get(r) ?? 0, metric, currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            {colNames.map((c) => (
              <td key={c} className="total">
                {formatCompact(colTotals.get(c) ?? 0, metric, currency)}
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
