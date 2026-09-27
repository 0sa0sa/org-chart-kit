import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'org-chart-kit/styles.css';
import { App } from './App';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
