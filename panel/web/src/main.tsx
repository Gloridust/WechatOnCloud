import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

// The panel is a live remote desktop gateway; stale PWA caches can keep an old
// login bundle alive after Cloudflare Access reauth. Retire any SW installed by
// earlier releases and clear its Cache Storage entries.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => {});
}

if ('caches' in window) {
  caches.keys()
    .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
