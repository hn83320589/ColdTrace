import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { formatTaipei, type ReadingPoint } from '@coldtrace/shared';
import { insertGaps } from '../lib/series';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkAreaComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

interface Props {
  points: ReadingPoint[];
  from: number;
  to: number;
  /** 每次繪製完成回報耗時（毫秒），用於驗證 1 秒內完成繪製 */
  onRendered?: (ms: number) => void;
}

export function TemperatureChart({ points, from, to, onRendered }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const instance = echarts.init(container.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const started = performance.now();
    instance.off('finished');
    instance.on('finished', () => {
      instance.off('finished');
      onRendered?.(performance.now() - started);
    });

    instance.setOption(
      {
        animation: false,
        grid: { left: 48, right: 16, top: 16, bottom: 32 },
        tooltip: {
          trigger: 'axis',
          valueFormatter: (v: unknown) => (typeof v === 'number' ? `${v.toFixed(1)}°C` : '無資料'),
          axisPointer: {
            label: { formatter: (p: { value: unknown }) => formatTaipei(Number(p.value)) },
          },
        },
        xAxis: {
          type: 'time',
          min: from,
          max: to,
          axisLabel: { formatter: (v: number) => formatTaipei(v).slice(11), hideOverlap: true },
        },
        yAxis: {
          type: 'value',
          name: '°C',
          min: (v: { min: number }) => Math.floor(Math.min(v.min, 1)),
          max: (v: { max: number }) => Math.ceil(Math.max(v.max, 9)),
        },
        visualMap: {
          show: false,
          dimension: 1,
          pieces: [
            { lt: 2, color: '#2563eb' },
            { gte: 2, lte: 8, color: '#0f766e' },
            { gt: 8, color: '#dc2626' },
          ],
        },
        series: [
          {
            type: 'line',
            name: '溫度',
            data: insertGaps(points),
            showSymbol: false,
            connectNulls: false,
            lineStyle: { width: 1.5 },
            markArea: {
              silent: true,
              itemStyle: { color: 'rgba(15, 118, 110, 0.08)' },
              data: [[{ yAxis: 2 }, { yAxis: 8 }]],
            },
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { type: 'dashed', color: '#94a3b8' },
              label: { formatter: '{c}°C', position: 'insideEndTop' },
              data: [{ yAxis: 2 }, { yAxis: 8 }],
            },
          },
        ],
      },
      { notMerge: false, lazyUpdate: false },
    );
  }, [points, from, to, onRendered]);

  return <div ref={container} className="chart" role="img" aria-label="近 24 小時溫度折線圖" />;
}
