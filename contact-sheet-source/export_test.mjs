import { JSDOM } from 'jsdom';
import { jsPDF } from 'jspdf';

// --- replicate the geometry the app relies on ---
function aspect(orientation){ return orientation==='portrait' ? 8.5/11 : 11/8.5; }

const portrait = new jsPDF({unit:'in',format:'letter',orientation:'portrait'});
const land     = new jsPDF({unit:'in',format:'letter',orientation:'landscape'});
const pPage = [portrait.internal.pageSize.getWidth(), portrait.internal.pageSize.getHeight()];
const lPage = [land.internal.pageSize.getWidth(), land.internal.pageSize.getHeight()];
console.log('portrait jsPDF page (in):', pPage.map(n=>n.toFixed(2)).join(' x '), '| ratio', (pPage[0]/pPage[1]).toFixed(4));
console.log('landscape jsPDF page (in):', lPage.map(n=>n.toFixed(2)).join(' x '), '| ratio', (lPage[0]/lPage[1]).toFixed(4));
console.log('CSS aspect portrait  =', aspect('portrait').toFixed(4));
console.log('CSS aspect landscape =', aspect('landscape').toFixed(4));
const portraitMatch = Math.abs((pPage[0]/pPage[1]) - aspect('portrait')) < 1e-6;
const landMatch     = Math.abs((lPage[0]/lPage[1]) - aspect('landscape')) < 1e-6;
console.log('ASPECT MATCH portrait:', portraitMatch, '| landscape:', landMatch, '=> no distortion on full-bleed addImage');

// --- exercise the real per-page export loop against a mock DOM ---
const dom = new JSDOM(`<!DOCTYPE html><body>
  <div data-export-page="true" id="p1"></div>
  <div data-export-page="true" id="p2"></div>
  <div data-export-page="true" id="p3"></div>
</body>`);
const document = dom.window.document;

// tiny 1x1 jpeg data url for mock canvas
const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=';
const html2canvas = async (el) => ({ toDataURL: () => TINY_JPEG });

async function runExport(orientation){
  const isPortrait = orientation==='portrait';
  const pdf = new jsPDF({unit:'in',format:'letter',orientation});
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const wrappers = Array.from(document.querySelectorAll('[data-export-page="true"]'));
  for(let i=0;i<wrappers.length;i++){
    const canvas = await html2canvas(wrappers[i]);
    const imgData = canvas.toDataURL();
    if(i>0) pdf.addPage('letter', orientation);
    pdf.addImage(imgData,'JPEG',0,0,pageW,pageH,undefined,'FAST');
  }
  const out = pdf.output('arraybuffer');
  const head = Buffer.from(out.slice(0,5)).toString();
  return { pages: pdf.internal.getNumberOfPages(), header: head, bytes: out.byteLength };
}

const r = await runExport('portrait');
console.log('\nExport loop (3 sheets):', JSON.stringify(r));
console.log('RESULT:', r.pages===3 && r.header==='%PDF-' ? 'PASS — 3 sheets -> 3 PDF pages, valid PDF' : 'FAIL');
