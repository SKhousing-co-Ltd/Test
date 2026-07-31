import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { FrontendDiagnostics } from './FrontendDiagnostics';
import './index.css';
import './ux.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <FrontendDiagnostics />
  </StrictMode>,
);
