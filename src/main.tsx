import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import {ErrorBoundary, isWebGLAvailable, WebGLUnsupported} from './ErrorBoundary.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isWebGLAvailable() ? <App /> : <WebGLUnsupported />}
    </ErrorBoundary>
  </StrictMode>,
);
