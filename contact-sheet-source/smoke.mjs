import { renderToString } from 'react-dom/server';
import React from 'react';
import App from './src/ContactSheetApp.tsx';
try {
  const html = renderToString(React.createElement(App));
  const ok = html.includes('Contact Sheets') && html.includes('New project');
  console.log('rendered length:', html.length, '| dashboard present:', ok);
  console.log('SMOKE:', ok ? 'PASS — component mounts and renders dashboard' : 'FAIL');
} catch(e){ console.log('SMOKE: FAIL —', e.message); }
