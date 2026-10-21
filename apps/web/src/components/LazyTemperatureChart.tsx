import { lazy, Suspense, type ComponentProps } from 'react';

// ECharts + zrender 約 540 kB，獨立成 chunk，不拖慢首屏
const load = () => import('./TemperatureChart');
const Chart = lazy(() => load().then((m) => ({ default: m.TemperatureChart })));

/** 儀表板載入後先在背景下載圖表程式，點開冷藏櫃時不必再等 */
export const preloadTemperatureChart = (): void => void load();

export function TemperatureChart(props: ComponentProps<typeof Chart>) {
  return (
    <Suspense fallback={<div className="chart chart-loading">載入中…</div>}>
      <Chart {...props} />
    </Suspense>
  );
}
