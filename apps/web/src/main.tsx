import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 元素');

createRoot(root).render(
  <StrictMode>
    <h1>ColdTrace</h1>
  </StrictMode>,
);
