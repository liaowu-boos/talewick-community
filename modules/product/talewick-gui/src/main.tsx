import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ma-shan-zheng/400.css';
import './styles/globals.css';
import App from './App';
import { DesignPreview } from '@/features/DesignPreview';

const isDesignPreview = document.documentElement.dataset.view === 'design' || new URLSearchParams(window.location.search).get('view') === 'design';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{isDesignPreview ? <DesignPreview /> : <App />}</React.StrictMode>);
