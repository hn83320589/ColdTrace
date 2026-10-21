import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { DevicesPage } from './pages/DevicesPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { EventsPage } from './pages/EventsPage';
import { ReportsPage } from './pages/ReportsPage';
import { RealtimeProvider } from './realtime';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 元素');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<DashboardPage />} />
              <Route path="events" element={<EventsPage />} />
              <Route path="events/:id" element={<EventDetailPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="devices" element={<DevicesPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </RealtimeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
