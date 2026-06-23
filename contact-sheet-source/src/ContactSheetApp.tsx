import { useState, useEffect, useRef, useCallback } from 'react';
import {
  FolderPlus, FilePlus, Image as ImageIcon, Trash2, Settings, ArrowRight,
  UploadCloud, FileDown, CheckSquare, X, Search, Sun, Moon,
  ChevronRight, ChevronDown, Folder, FileText, Aperture, Undo2, Redo2,
  Edit2, ArrowLeft, Maximize, Minimize
} from 'lucide-react';

/* =============================================================================
   Contact Sheets — darkroom proof-sheet builder.
   Structure: Project → nested Folders → Sheets → auto-paginated pages of frames.
   Suite aesthetic: near-black neutrals, amber safelight accent, mono metadata.
   ========================================================================== */

const generateId = () =>
  typeof crypto !== 'undefined' && (crypto as any).randomUUID
    ? (crypto as any).randomUUID()
    : Math.random().toString(36).slice(2, 12);

const DEFAULT_SETTINGS = {
  columns: 4,
  rows: 6,
  orientation: 'portrait',
  bgColor: '#0a0a0a',
  showFileNames: true,
  fileNameOpacity: 55,
  fileNameSize: 10,
  imageScale: 98,
};

// ---------------------------------------------------------------------------
// IndexedDB persistence
// ---------------------------------------------------------------------------
const DB_NAME = 'ContactSheetDB';
const STORE_NAME = 'projects';
const DB_VERSION = 1;

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e: any) => {
      const db = e.target.result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const loadProjectsFromDB = async (): Promise<any[]> => {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('DB load error', e);
    return [];
  }
};

const saveProjectToDB = async (project: any) => {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(project);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('DB save error', e);
  }
};

const deleteProjectFromDB = async (id: string) => {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('DB delete error', e);
  }
};

// ---------------------------------------------------------------------------
// Image downscale on import (keeps the DB light)
// ---------------------------------------------------------------------------
const downscaleImage = (file: File): Promise<string> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e: any) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 800;
        const ratio = MAX_WIDTH / img.width;
        if (ratio >= 1) return resolve(e.target.result);
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * ratio;
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });

// ---------------------------------------------------------------------------
// Export library loaders (runtime CDN; works on Vercel + artifact preview)
// ---------------------------------------------------------------------------
const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (Array.from(document.scripts).some((s) => s.src === src)) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(el);
  });

const loadHtml2Canvas = async () => {
  const w = window as any;
  if (!w.html2canvas) await loadScript('https://cdn.jsdelivr.net/npm/html2canvas-pro@2.0.4/dist/html2canvas-pro.min.js');
  return w.html2canvas.default || w.html2canvas;
};
const loadJsPDF = async () => {
  const w = window as any;
  if (!w.jspdf) await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js');
  return w.jspdf;
};
const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// ---------------------------------------------------------------------------
// Tree utilities (immutable). Node = folder {children} | sheet {pages}
// ---------------------------------------------------------------------------
type AnyNode = any;

const walk = (nodes: AnyNode[], fn: (n: AnyNode) => void) => {
  nodes.forEach((n) => { fn(n); if (n.type === 'folder') walk(n.children, fn); });
};
const findNode = (nodes: AnyNode[], id: string): AnyNode | null => {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'folder') { const f = findNode(n.children, id); if (f) return f; }
  }
  return null;
};
const updateNode = (nodes: AnyNode[], id: string, fn: (n: AnyNode) => AnyNode): AnyNode[] =>
  nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.type === 'folder') return { ...n, children: updateNode(n.children, id, fn) };
    return n;
  });
const removeNode = (nodes: AnyNode[], id: string): { tree: AnyNode[]; removed: AnyNode | null } => {
  let removed: AnyNode | null = null;
  const tree = nodes
    .filter((n) => { if (n.id === id) { removed = n; return false; } return true; })
    .map((n) => {
      if (n.type === 'folder') { const r = removeNode(n.children, id); if (r.removed) removed = r.removed; return { ...n, children: r.tree }; }
      return n;
    });
  return { tree, removed };
};
const insertNode = (nodes: AnyNode[], parentId: string | null, node: AnyNode, index = -1): AnyNode[] => {
  if (parentId === null) {
    const copy = [...nodes];
    if (index < 0 || index > copy.length) copy.push(node); else copy.splice(index, 0, node);
    return copy;
  }
  return nodes.map((n) => {
    if (n.id === parentId && n.type === 'folder') {
      const children = [...n.children];
      if (index < 0 || index > children.length) children.push(node); else children.splice(index, 0, node);
      return { ...n, children };
    }
    if (n.type === 'folder') return { ...n, children: insertNode(n.children, parentId, node, index) };
    return n;
  });
};
const isDescendant = (node: AnyNode, targetId: string): boolean => {
  if (node.id === targetId) return true;
  if (node.type === 'folder') return node.children.some((c: AnyNode) => isDescendant(c, targetId));
  return false;
};
const countSheets = (nodes: AnyNode[]): number => { let n = 0; walk(nodes, (x) => { if (x.type === 'sheet') n++; }); return n; };
const countFrames = (nodes: AnyNode[]): number => { let n = 0; walk(nodes, (x) => { if (x.type === 'sheet') x.pages.forEach((p: any) => (n += p.items.length)); }); return n; };
const firstFrame = (nodes: AnyNode[]): string | null => {
  let found: string | null = null;
  walk(nodes, (x) => { if (!found && x.type === 'sheet') { for (const p of x.pages) { if (p.items[0]) { found = p.items[0].data; break; } } } });
  return found;
};

// Pagination: flatten a sheet's frames and re-chunk into pages of `cap`.
const flatFrames = (sheet: AnyNode): any[] => sheet.pages.flatMap((p: any) => p.items);
const chunkToPages = (frames: any[], cap: number): any[] => {
  if (cap < 1) cap = 1;
  if (frames.length === 0) return [{ id: generateId(), items: [] }];
  const pages: any[] = [];
  for (let i = 0; i < frames.length; i += cap) pages.push({ id: generateId(), items: frames.slice(i, i + cap) });
  return pages;
};
const effSettings = (project: any, sheet: AnyNode) => ({ ...DEFAULT_SETTINGS, ...project.settings, ...(sheet?.settingsOverride || {}) });

// ===========================================================================
// Shared UI
// ===========================================================================
const Modal = ({ isOpen, onClose, title, children }: any) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[1000] flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col border border-neutral-800" onMouseDown={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-950">
          <h3 className="font-semibold text-lg text-white tracking-tight">{title}</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors"><X size={20} /></button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
};

const Lightbox = ({ img, onClose }: any) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[1100] bg-black/95 backdrop-blur-md flex flex-col items-center justify-center p-8 cursor-zoom-out" onMouseDown={onClose}>
      <button onClick={onClose} className="absolute top-5 right-5 flex items-center gap-2 text-white/90 bg-white/10 hover:bg-white/20 rounded-full pl-4 pr-3 py-2 text-sm font-medium transition-colors">Close <X size={18} /></button>
      <img src={img.data} alt="" className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm cursor-default" onMouseDown={(e) => e.stopPropagation()} />
      {img.filename && <div className="absolute bottom-8 px-4 py-2 bg-black/70 text-white rounded-lg text-sm font-mono tracking-wide pointer-events-none">{img.filename}</div>}
      <div className="absolute bottom-2 left-0 right-0 text-center text-white/40 text-xs pointer-events-none">Esc or click anywhere to close</div>
    </div>
  );
};

const Toast = ({ message, type = 'info', onClose }: any) => {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, [onClose]);
  const bar = type === 'error' ? 'border-l-red-500' : type === 'success' ? 'border-l-amber-500' : 'border-l-neutral-600';
  return <div className={`fixed bottom-4 right-4 pl-4 pr-6 py-3 rounded-xl shadow-2xl text-white font-medium z-[1200] bg-neutral-900 border border-neutral-700 border-l-4 ${bar}`}>{message}</div>;
};

// ===========================================================================
// Dashboard — project cards
// ===========================================================================
const DashboardView = ({ projects, isDark, onToggleTheme, onNewProject, onOpenProject, onDeleteProject }: any) => {
  const [q, setQ] = useState('');
  const filtered = projects.filter((p: any) => p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 p-8 transition-colors">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">
        <div className="flex justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="h-11 w-11 rounded-xl bg-amber-500 text-neutral-950 flex items-center justify-center shadow-sm shrink-0"><Aperture size={24} strokeWidth={2.25} /></div>
            <div>
              <h1 className="text-3xl font-bold text-neutral-900 dark:text-white tracking-tight">Contact Sheets</h1>
              <p className="text-neutral-500 dark:text-neutral-400 mt-0.5 font-mono text-xs uppercase tracking-[0.2em]">Proof &amp; layout · {projects.length} {projects.length === 1 ? 'project' : 'projects'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={onToggleTheme} className="text-neutral-500 dark:text-neutral-400 hover:text-amber-500 p-2.5 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors" title={isDark ? 'Switch to light' : 'Switch to dark'}>{isDark ? <Sun size={20} /> : <Moon size={20} />}</button>
            <button onClick={onNewProject} className="bg-amber-500 hover:bg-amber-400 text-neutral-950 px-6 py-3 rounded-xl font-semibold transition-colors shadow-sm flex items-center gap-2"><FolderPlus size={20} /> New project</button>
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 p-4 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-800 flex gap-4 items-center">
          <Search className="text-neutral-400 ml-2" size={20} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" className="flex-1 outline-none text-neutral-700 dark:text-neutral-200 bg-transparent placeholder:text-neutral-400" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.length === 0 ? (
            <div className="col-span-full py-16 text-center text-neutral-400 border-2 border-dashed border-neutral-200 dark:border-neutral-800 rounded-3xl">
              <Aperture size={48} className="mx-auto mb-4 opacity-40" />
              <p className="text-lg">No projects yet. Create one to start.</p>
            </div>
          ) : filtered.map((project: any) => {
            const cover = project.coverPhoto || firstFrame(project.tree || []);
            const sheets = countSheets(project.tree || []);
            const frames = countFrames(project.tree || []);
            return (
              <div key={project.id} className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-800 overflow-hidden hover:shadow-md hover:border-neutral-300 dark:hover:border-neutral-700 transition-all group flex flex-col">
                <div className="h-40 bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center cursor-pointer relative overflow-hidden" onClick={() => onOpenProject(project.id)}>
                  {cover ? <img src={cover} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" /> : (
                    <>
                      <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 gap-0.5 p-2 opacity-20">{Array.from({ length: 16 }).map((_, i) => <div key={i} className="bg-neutral-400 dark:bg-neutral-500 rounded-sm" />)}</div>
                      <Aperture size={36} className="text-neutral-300 dark:text-neutral-600 relative z-10" />
                    </>
                  )}
                </div>
                <div className="p-5 flex justify-between items-start">
                  <div className="cursor-pointer flex-1 min-w-0" onClick={() => onOpenProject(project.id)}>
                    <h3 className="font-semibold text-lg text-neutral-800 dark:text-white line-clamp-1">{project.name}</h3>
                    <p className="text-xs font-mono uppercase tracking-wider text-neutral-500 mt-1.5">{new Date(project.lastModified).toLocaleDateString()} · {sheets} sheets · {frames} frames</p>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); onDeleteProject(project.id); }} className="text-neutral-400 hover:text-red-500 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950 transition-colors" title="Delete project"><Trash2 size={18} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ===========================================================================
// Finder-style tree nav
// ===========================================================================
const TreeRow = ({ node, depth, openSheetId, collapsed, onToggleCollapse, onOpenSheet, onRename, onDelete,
  dragId, dropTarget, onDragStart, onDragEnd, onDropInto, onDropBefore, frameCountFor }: any) => {
  const isFolder = node.type === 'folder';
  const isOpen = openSheetId === node.id;
  const isCollapsed = collapsed[node.id];
  const isDragging = dragId === node.id;
  const intoActive = dropTarget?.kind === 'into' && dropTarget.id === node.id;
  const beforeActive = dropTarget?.kind === 'before' && dropTarget.id === node.id;

  return (
    <div className={isDragging ? 'opacity-40' : ''}>
      {/* insertion line (drop before) */}
      <div className={`h-0.5 -mb-0.5 mx-2 rounded-full transition-colors ${beforeActive ? 'bg-amber-400' : 'bg-transparent'}`} />
      <div
        draggable
        onDragStart={(e) => { e.stopPropagation(); onDragStart(node.id); }}
        onDragEnd={onDragEnd}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); onDropTargetChange(e, node, isFolder, onDropBefore, onDropInto); }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onPerformDrop(node, isFolder); }}
        style={{ paddingLeft: depth * 16 + 8 }}
        className={`group/row flex items-center gap-1.5 pr-2 py-1.5 rounded-lg cursor-pointer select-none transition-colors
          ${isOpen ? 'bg-amber-500/15 text-amber-300' : 'text-neutral-300 hover:bg-white/5'}
          ${intoActive ? 'ring-2 ring-amber-400 bg-amber-400/10' : ''}`}
        onClick={() => { if (isFolder) onToggleCollapse(node.id); else onOpenSheet(node.id); }}
      >
        {isFolder ? (
          <span className="text-neutral-500 shrink-0">{isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</span>
        ) : <span className="w-[15px] shrink-0" />}
        <span className={`shrink-0 ${isFolder ? 'text-amber-400/80' : isOpen ? 'text-amber-300' : 'text-neutral-500'}`}>
          {isFolder ? <Folder size={15} /> : <FileText size={15} />}
        </span>
        <span className="flex-1 truncate text-sm font-medium">{node.name}</span>
        {!isFolder && <span className="font-mono text-[10px] text-neutral-500 tabular-nums">{frameCountFor(node)}</span>}
        <div className="hidden group-hover/row:flex items-center gap-0.5">
          <button onClick={(e) => { e.stopPropagation(); onRename(node); }} className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-white" title="Rename"><Edit2 size={13} /></button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(node); }} className="p-1 rounded hover:bg-white/10 text-neutral-400 hover:text-red-400" title="Delete"><Trash2 size={13} /></button>
        </div>
      </div>
      {isFolder && !isCollapsed && (
        <div>
          {node.children.length === 0 ? (
            <div style={{ paddingLeft: (depth + 1) * 16 + 24 }} className="py-1 text-[11px] text-neutral-600 italic">empty</div>
          ) : node.children.map((c: AnyNode) => (
            <TreeRow key={c.id} node={c} depth={depth + 1} {...{ openSheetId, collapsed, onToggleCollapse, onOpenSheet, onRename, onDelete, dragId, dropTarget, onDragStart, onDragEnd, onDropInto, onDropBefore, frameCountFor }} />
          ))}
        </div>
      )}
    </div>
  );
};

// helpers to compute drop intent from the hovered row (module-level closures set per render)
let _setDropTarget: any = null;
let _pendingDrop: any = null;
const onDropTargetChange = (_e: any, node: AnyNode, isFolder: boolean, onBefore: any, onInto: any) => {
  // Folders accept "into"; everything accepts "before" (reorder)
  if (_setDropTarget) _setDropTarget(isFolder ? { kind: 'into', id: node.id } : { kind: 'before', id: node.id });
  _pendingDrop = isFolder ? () => onInto(node.id) : () => onBefore(node.id);
};
const onPerformDrop = (_node: AnyNode, _isFolder: boolean) => { if (_pendingDrop) _pendingDrop(); };

const FinderNav = ({ project, openSheetId, onOpenSheet, onMutate, onAddFolder, onAddSheet, onRename, onDelete }: any) => {
  const [collapsed, setCollapsed] = useState<any>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<any>(null);
  _setDropTarget = setDropTarget;

  const toggleCollapse = (id: string) => setCollapsed((c: any) => ({ ...c, [id]: !c[id] }));
  const frameCountFor = (sheet: AnyNode) => sheet.pages.reduce((n: number, p: any) => n + p.items.length, 0);

  const move = (parentId: string | null, beforeId: string | null) => {
    if (!dragId) return;
    const dragged = findNode(project.tree, dragId);
    if (!dragged) return;
    if (parentId && (dragId === parentId || isDescendant(dragged, parentId))) { setDragId(null); setDropTarget(null); return; }
    let { tree, removed } = removeNode(project.tree, dragId);
    if (!removed) return;
    if (beforeId) {
      // insert before a sibling: find its parent + index
      const locate = (nodes: AnyNode[], pid: string | null): any => {
        const idx = nodes.findIndex((n) => n.id === beforeId);
        if (idx !== -1) return { pid, idx };
        for (const n of nodes) if (n.type === 'folder') { const r = locate(n.children, n.id); if (r) return r; }
        return null;
      };
      const loc = locate(tree, null);
      if (loc) tree = insertNode(tree, loc.pid, removed, loc.idx);
      else tree = insertNode(tree, null, removed, -1);
    } else {
      tree = insertNode(tree, parentId, removed, -1);
    }
    onMutate({ ...project, tree });
    setDragId(null);
    setDropTarget(null);
  };

  return (
    <div
      className="w-64 bg-neutral-950 border-r border-neutral-800 flex flex-col h-full no-print"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (dragId) move(null, null); }}
    >
      <div className="p-3 border-b border-neutral-800 flex items-center gap-2">
        <button onClick={onAddSheet} className="flex-1 flex items-center justify-center gap-1.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 py-2 rounded-lg text-sm font-semibold transition-colors"><FilePlus size={15} /> Sheet</button>
        <button onClick={onAddFolder} className="flex-1 flex items-center justify-center gap-1.5 bg-white/5 hover:bg-white/10 text-neutral-300 border border-neutral-800 py-2 rounded-lg text-sm font-semibold transition-colors"><FolderPlus size={15} /> Folder</button>
      </div>
      <div
        className="flex-1 overflow-y-auto p-2"
        onDragEnter={() => { if (dragId) { setDropTarget(null); _pendingDrop = () => move(null, null); } }}
      >
        {project.tree.length === 0 ? (
          <div className="text-center text-neutral-600 text-sm py-10 px-4">No sheets yet. Add one above to start laying out frames.</div>
        ) : project.tree.map((n: AnyNode) => (
          <TreeRow key={n.id} node={n} depth={0} {...{
            openSheetId, collapsed, onToggleCollapse: toggleCollapse, onOpenSheet, onRename, onDelete,
            dragId, dropTarget,
            onDragStart: setDragId, onDragEnd: () => { setDragId(null); setDropTarget(null); },
            onDropInto: (id: string) => move(id, null),
            onDropBefore: (id: string) => move(null, id),
            frameCountFor,
          }} />
        ))}
        <div className="h-12" onDragEnter={() => { if (dragId) { setDropTarget(null); _pendingDrop = () => move(null, null); } }} />
      </div>
    </div>
  );
};

// ===========================================================================
// Staging sidebar (project-wide image pool)
// ===========================================================================
const StagingSidebar = ({ project, onMutate, draggedItem, setDraggedItem, hasOpenSheet }: any) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [lastIdx, setLastIdx] = useState<number | null>(null);
  const staging = project.staging || [];

  const upload = async (e: any) => {
    const files = Array.from(e.target.files) as File[];
    if (!files.length) return;
    const added: any[] = [];
    for (const f of files) if (f.type.startsWith('image/')) added.push({ id: generateId(), data: await downscaleImage(f), filename: f.name, selected: false });
    onMutate({ ...project, staging: [...staging, ...added] });
    e.target.value = '';
  };
  const toggle = (idx: number, ev: any) => {
    const next = staging.map((s: any) => ({ ...s }));
    if (ev.shiftKey && lastIdx !== null) { const a = Math.min(idx, lastIdx), b = Math.max(idx, lastIdx); for (let i = a; i <= b; i++) next[i].selected = true; }
    else { next[idx].selected = !next[idx].selected; setLastIdx(idx); }
    onMutate({ ...project, staging: next });
  };
  const selectAll = () => { const all = staging.every((s: any) => s.selected); onMutate({ ...project, staging: staging.map((s: any) => ({ ...s, selected: !all })) }); };
  const delSel = () => { onMutate({ ...project, staging: staging.filter((s: any) => !s.selected) }); setLastIdx(null); };
  const selCount = staging.filter((s: any) => s.selected).length;

  return (
    <div className="w-72 bg-neutral-900 border-r border-neutral-800 flex flex-col h-full no-print">
      <div className="p-4 border-b border-neutral-800">
        <h2 className="font-semibold flex items-center gap-2 text-white mb-3"><ImageIcon size={17} className="text-amber-400" /> Staging <span className="ml-auto font-mono text-xs text-neutral-500 tabular-nums">{staging.length}</span></h2>
        <input type="file" multiple accept="image/*" className="hidden" ref={fileRef} onChange={upload} />
        <button onClick={() => fileRef.current?.click()} className="w-full bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 py-2.5 rounded-xl font-medium transition-colors flex justify-center items-center gap-2 border border-amber-500/20"><UploadCloud size={17} /> Upload photos</button>
        <div className="mt-3 flex gap-2 text-sm">
          <button onClick={selectAll} className="flex-1 bg-white/5 hover:bg-white/10 text-neutral-300 py-1.5 rounded-full font-medium transition-colors">{selCount === staging.length && selCount > 0 ? 'Deselect all' : 'Select all'}</button>
          {selCount > 0 && <button onClick={delSel} className="px-4 bg-red-900/30 hover:bg-red-900/50 text-red-400 py-1.5 rounded-full font-medium transition-colors">Delete ({selCount})</button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 bg-neutral-950">
        {staging.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-neutral-600 p-4 text-center"><ImageIcon size={30} className="mb-2 opacity-20" /><p className="text-sm">Upload photos here, then drag or auto-fill them onto a sheet.</p></div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {staging.map((img: any, idx: number) => {
              return (
                <div key={img.id} draggable
                  onDragStart={() => setDraggedItem({ source: 'staging', item: img })}
                  onDragEnd={() => setDraggedItem(null)}
                  onClick={(e) => toggle(idx, e)}
                  className={`aspect-square rounded-xl cursor-pointer bg-cover bg-center border-2 transition-all overflow-hidden relative
                    ${img.selected ? 'border-amber-400 ring-2 ring-amber-500/30 scale-95' : 'border-transparent hover:border-neutral-600'}
                    ${draggedItem?.item?.id === img.id ? 'opacity-50 grayscale' : ''}`}
                  style={{ backgroundImage: `url(${img.data})` }} title={img.filename}>
                  {img.selected && <div className="absolute top-1.5 right-1.5 bg-amber-500 text-neutral-950 rounded-full p-0.5 shadow z-10 pointer-events-none"><CheckSquare size={13} /></div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="p-3 border-t border-neutral-800 text-[10px] text-neutral-600 font-mono uppercase tracking-wider text-center">
        {hasOpenSheet ? 'Select photos, then Auto-fill →' : 'Open a sheet to place photos'}
      </div>
    </div>
  );
};

// ===========================================================================
// Sheet editor — the page canvas
// ===========================================================================
const SheetEditor = ({ project, sheet, eff, updateSheet, onCommit, draggedItem, setDraggedItem, addToast, setPreviewImg, openSettings }: any) => {
  const [dragOverFrameId, setDragOverFrameId] = useState<string | null>(null);
  const [dragOverPageId, setDragOverPageId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportQuality, setExportQuality] = useState(85);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const cap = Math.max(1, eff.columns * eff.rows);
  const isPortrait = eff.orientation !== 'landscape';
  const aspectClass = isPortrait ? 'aspect-[8.5/11]' : 'aspect-[11/8.5]';
  const maxWidthClass = isPortrait ? 'max-w-[850px]' : 'max-w-[1100px]';

  // All frame mutations funnel through here: edit the flat list, re-paginate.
  const setFrames = (frames: any[]) => updateSheet(sheet.id, (s: any) => ({ ...s, pages: chunkToPages(frames, cap) }));

  // Place staging items + clear their selection in ONE commit (avoids a stale
  // second commit clobbering the first).
  const placeStaging = (items: any[], beforeFrameId: string | null) => {
    const additions = items.map((i: any) => ({ id: generateId(), data: i.data, filename: i.filename }));
    const flat = flatFrames(sheet);
    if (beforeFrameId) {
      const idx = flat.findIndex((f) => f.id === beforeFrameId);
      flat.splice(idx < 0 ? flat.length : idx, 0, ...additions);
    } else flat.push(...additions);
    onCommit({
      ...project,
      tree: updateNode(project.tree, sheet.id, (s: any) => ({ ...s, pages: chunkToPages(flat, cap) })),
      staging: project.staging.map((s: any) => (s.selected ? { ...s, selected: false } : s)),
    });
  };

  const moveFrame = (frameId: string, beforeFrameId: string | null) => {
    let flat = flatFrames(sheet);
    const from = flat.findIndex((f) => f.id === frameId);
    if (from < 0) return;
    const [moved] = flat.splice(from, 1);
    if (beforeFrameId) {
      const idx = flat.findIndex((f) => f.id === beforeFrameId);
      flat.splice(idx < 0 ? flat.length : idx, 0, moved);
    } else flat.push(moved);
    setFrames(flat);
  };

  const deleteFrame = (frameId: string) => setFrames(flatFrames(sheet).filter((f) => f.id !== frameId));
  const clearSheet = () => { setFrames([]); addToast('Sheet cleared.', 'success'); };

  const handleDropOnFrame = (e: any, targetId: string) => {
    e.preventDefault(); e.stopPropagation();
    setDragOverFrameId(null); setDragOverPageId(null);
    if (!draggedItem) return;
    if (draggedItem.source === 'staging') {
      const sel = project.staging.filter((s: any) => s.selected);
      const items = (sel.length && draggedItem.item.selected) ? sel : [draggedItem.item];
      placeStaging(items, targetId);
    } else if (draggedItem.source === 'frame') {
      if (draggedItem.item.id !== targetId) moveFrame(draggedItem.item.id, targetId);
    }
    setDraggedItem(null);
  };

  const handleDropOnSheet = (e: any) => {
    e.preventDefault();
    setDragOverFrameId(null); setDragOverPageId(null);
    if (!draggedItem) return;
    if (draggedItem.source === 'staging') {
      const sel = project.staging.filter((s: any) => s.selected);
      const items = (sel.length && draggedItem.item.selected) ? sel : [draggedItem.item];
      placeStaging(items, null);
    } else if (draggedItem.source === 'frame') {
      moveFrame(draggedItem.item.id, null);
    }
    setDraggedItem(null);
  };

  const autoFill = () => {
    const sel = project.staging.filter((s: any) => s.selected);
    if (!sel.length) return addToast('Select photos in Staging first.', 'error');
    placeStaging(sel, null);
    addToast(`Placed ${sel.length} ${sel.length === 1 ? 'photo' : 'photos'}.`, 'success');
  };

  // ---- PDF export: one page per sheet page, full-bleed (no slicing) --------
  const handleExportPDF = async () => {
    setIsExporting(true);
    addToast('Building your PDF…', 'info');
    await nextPaint();
    await new Promise((r) => setTimeout(r, 200));
    let stage = 'starting';
    try {
      stage = 'loading export libraries';
      const html2canvas = await loadHtml2Canvas();
      const { jsPDF } = await loadJsPDF();
      if (typeof html2canvas !== 'function' || typeof jsPDF !== 'function') throw new Error('libraries did not load');
      const orientation = isPortrait ? 'portrait' : 'landscape';
      const pdf = new jsPDF({ unit: 'in', format: 'letter', orientation });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const wrappers = Array.from(document.querySelectorAll('[data-export-page="true"]')) as HTMLElement[];
      if (!wrappers.length) throw new Error('nothing to export');
      const targetPx = exportQuality >= 80 ? 1700 : 1275;
      let added = 0;
      for (let i = 0; i < wrappers.length; i++) {
        stage = `rendering page ${i + 1} of ${wrappers.length}`;
        const el = wrappers[i];
        const scale = Math.min(2, Math.max(1, targetPx / (el.offsetWidth || 850)));
        const canvas = await html2canvas(el, { scale, useCORS: true, logging: false, backgroundColor: eff.bgColor || '#000', imageTimeout: 15000, removeContainer: true });
        const imgData = canvas.toDataURL('image/jpeg', exportQuality / 100);
        canvas.width = 0; canvas.height = 0;
        if (added > 0) pdf.addPage('letter', orientation);
        pdf.addImage(imgData, 'JPEG', 0, 0, pageW, pageH, undefined, 'FAST');
        added++;
        await new Promise((r) => setTimeout(r, 0));
      }
      stage = 'saving file';
      pdf.save(`${(project.name + '_' + sheet.name).replace(/\s+/g, '_')}.pdf`);
      addToast('PDF saved.', 'success');
    } catch (err) {
      console.error('PDF export failed while:', stage, err);
      addToast(`Export failed while ${stage}. See console.`, 'error');
    } finally {
      setIsExporting(false);
      setIsExportModalOpen(false);
    }
  };

  const totalFrames = sheet.pages.reduce((n: number, p: any) => n + p.items.length, 0);
  const nonEmpty = sheet.pages.filter((p: any) => p.items.length > 0).length;
  const estSize = (Math.max(1, totalFrames) * 0.18 * (exportQuality / 100)).toFixed(1);

  const wrapClass = isFullscreen ? 'fixed inset-0 z-[100] flex flex-col bg-neutral-950' : 'flex-1 flex flex-col bg-neutral-950 h-full';

  return (
    <div className={wrapClass}>
      {/* toolbar */}
      <div className="h-16 bg-neutral-900 border-b border-neutral-800 flex items-center justify-between px-5 no-print shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <FileText size={18} className="text-amber-400 shrink-0" />
          <span className="font-bold text-white truncate">{sheet.name}</span>
          <span className="font-mono text-xs text-neutral-500 tabular-nums shrink-0">{totalFrames} frames · {sheet.pages.length}p</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 border-r border-neutral-700">
            <span className="text-sm text-neutral-400">Scale</span>
            <input type="range" min="10" max="100" value={eff.imageScale} onChange={(e) => updateSheet(sheet.id, (s: any) => ({ ...s, settingsOverride: { ...s.settingsOverride, imageScale: parseInt(e.target.value) } }))} className="w-20 accent-amber-500" />
            <span className="font-mono text-xs text-neutral-300 tabular-nums w-8">{eff.imageScale}%</span>
          </div>
          {/* Filename toggle — quick access above the canvas */}
          <label className="flex items-center gap-1.5 cursor-pointer px-3 border-r border-neutral-700" title="Show/hide filenames on frames">
            <input type="checkbox" checked={eff.showFileNames} onChange={(e) => updateSheet(sheet.id, (s: any) => ({ ...s, settingsOverride: { ...s.settingsOverride, showFileNames: e.target.checked } }))} className="w-3.5 h-3.5 accent-amber-500" />
            <span className="text-sm text-neutral-400 select-none">Filenames</span>
          </label>
          <button onClick={autoFill} className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 px-3 py-2 rounded-lg text-sm font-semibold border border-amber-500/20 flex items-center gap-1.5 transition-colors"><ArrowRight size={15} /> Auto-fill</button>
          <button onClick={() => setIsFullscreen(!isFullscreen)} className="text-neutral-400 hover:text-amber-400 p-2 rounded-lg hover:bg-white/5 transition-colors" title="Fullscreen">{isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>
          <button onClick={clearSheet} className="text-neutral-400 hover:text-red-500 p-2 rounded-lg hover:bg-white/5 transition-colors" title="Clear sheet"><Trash2 size={18} /></button>
          <button onClick={openSettings} className="text-neutral-400 hover:text-amber-400 p-2 rounded-lg hover:bg-white/5 transition-colors" title="Sheet settings"><Settings size={18} /></button>
          <button onClick={() => setIsExportModalOpen(true)} className="bg-amber-500 hover:bg-amber-400 text-neutral-950 px-4 py-2 rounded-lg font-semibold flex items-center gap-2 transition-colors"><FileDown size={17} /> Export</button>
        </div>
      </div>

      {/* canvas */}
      <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center gap-10">
        <style dangerouslySetInnerHTML={{ __html: `
          @media (prefers-reduced-motion: reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important}}
          :focus-visible{outline:2px solid #f59e0b;outline-offset:2px}
        `}} />
        {sheet.pages.map((page: any, index: number) => {
          if (isExporting && page.items.length === 0) return null;
          return (
            <div key={page.id} className={`flex flex-col w-full items-center gap-2 ${maxWidthClass}`}>
              {!isExporting && (
                <div className="w-full flex justify-between items-center px-1 no-print">
                  <span className="font-mono font-bold text-neutral-500 uppercase tracking-[0.2em] text-xs">Page {String(index + 1).padStart(2, '0')}</span>
                  <span className="font-mono text-[11px] text-neutral-600 tabular-nums">{page.items.length}/{cap}</span>
                </div>
              )}
              <div
                data-export-page="true"
                className={`relative page-wrapper w-full ${aspectClass} overflow-hidden ${isExporting ? '' : 'shadow-2xl border ' + (draggedItem && dragOverPageId === page.id ? 'border-amber-400 ring-2 ring-amber-400/40' : 'border-neutral-800')}`}
                style={{ backgroundColor: eff.bgColor || '#000' }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dragOverPageId !== page.id) setDragOverPageId(page.id); }}
                onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverPageId(null); }}
                onDrop={handleDropOnSheet}
              >
                <div className="w-full h-full grid gap-0" style={{ gridTemplateColumns: `repeat(${eff.columns}, minmax(0,1fr))`, gridTemplateRows: `repeat(${eff.rows}, minmax(0,1fr))` }}>
                  {page.items.map((item: any) => {
                    const dragging = draggedItem?.item?.id === item.id;
                    const target = dragOverFrameId === item.id && !dragging;
                    return (
                      <div key={item.id} draggable
                        onDragStart={(e) => { e.stopPropagation(); setDraggedItem({ source: 'frame', item }); }}
                        onDragEnd={() => { setDraggedItem(null); setDragOverFrameId(null); setDragOverPageId(null); }}
                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverFrameId(item.id); }}
                        onDragLeave={(e) => { e.stopPropagation(); if (e.currentTarget === e.target) setDragOverFrameId(null); }}
                        onDrop={(e) => handleDropOnFrame(e, item.id)}
                        onDoubleClick={(e) => { e.stopPropagation(); setPreviewImg(item); }}
                        className={`relative group/item cursor-move w-full h-full overflow-hidden flex items-center justify-center ${dragging ? 'opacity-40 grayscale' : ''}`}
                      >
                        {target && <div className="absolute inset-y-1 left-0 w-1.5 z-30 rounded-full bg-amber-400 shadow-[0_0_10px_2px_rgba(251,191,36,.85)] pointer-events-none" />}
                        {target && <div className="absolute inset-0 z-20 ring-2 ring-inset ring-amber-400/50 pointer-events-none" />}
                        <img src={item.data} alt={item.filename || ''} className="w-full h-full object-cover object-center pointer-events-none" style={{ transform: `scale(${eff.imageScale / 100})` }} />
                        {eff.showFileNames && item.filename && (
                          <div className="absolute bottom-0 left-0 right-0 text-white text-center font-mono whitespace-normal break-words leading-tight max-h-[45%] overflow-hidden z-10 pointer-events-none"
                            style={{ backgroundColor: `rgba(0,0,0,${(eff.fileNameOpacity ?? 55) / 100})`, fontSize: `${eff.fileNameSize || 10}px`, padding: '3px 4px' }}>
                            {item.filename}
                          </div>
                        )}
                        {!isExporting && (
                          <button onClick={() => deleteFrame(item.id)} className="absolute top-1.5 right-1.5 bg-black/60 text-white rounded-full p-1.5 opacity-0 group-hover/item:opacity-100 transition-opacity hover:bg-red-500 no-print z-20" title="Remove"><X size={13} /></button>
                        )}
                      </div>
                    );
                  })}
                  {page.items.length === 0 && !isExporting && (
                    <div className={`col-span-full h-full min-h-[340px] border-4 border-dashed flex flex-col items-center justify-center rounded-xl m-4 pointer-events-none transition-colors ${draggedItem ? 'border-amber-400 text-amber-500 bg-amber-400/10' : 'border-neutral-700 text-neutral-600'}`}>
                      <UploadCloud size={44} className="mb-3 opacity-60" />
                      <p className="font-medium">{draggedItem ? 'Drop to place here' : 'Drag photos here'}</p>
                      {!draggedItem && <p className="text-sm opacity-70">or use Auto-fill</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* export modal */}
      <Modal isOpen={isExportModalOpen} onClose={() => !isExporting && setIsExportModalOpen(false)} title="Export sheet as PDF">
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">Image quality <span className="font-mono text-amber-400">{exportQuality}%</span></label>
            <input type="range" min="10" max="100" step="5" value={exportQuality} onChange={(e) => setExportQuality(parseInt(e.target.value))} className="w-full accent-amber-500" disabled={isExporting} />
          </div>
          <div className="bg-neutral-800 p-4 rounded-xl border border-neutral-700 text-sm space-y-1.5">
            <div className="flex justify-between"><span className="text-neutral-400">Pages</span><span className="font-mono text-white">{nonEmpty}</span></div>
            <div className="flex justify-between"><span className="text-neutral-400">Frames</span><span className="font-mono text-white">{totalFrames}</span></div>
            <div className="flex justify-between pt-2 border-t border-neutral-700 mt-2"><span className="text-neutral-200 font-semibold">Est. size</span><span className="font-mono text-amber-400">~{estSize} MB</span></div>
          </div>
          <button onClick={handleExportPDF} disabled={isExporting || nonEmpty === 0} className="w-full bg-amber-500 text-neutral-950 rounded-lg py-3 font-semibold hover:bg-amber-400 transition-colors disabled:opacity-50 flex justify-center items-center gap-2">
            {isExporting ? <><span className="animate-spin rounded-full h-4 w-4 border-2 border-neutral-950 border-t-transparent" /> Building…</> : <><FileDown size={18} /> Download PDF</>}
          </button>
          {nonEmpty === 0 && <p className="text-xs text-center text-neutral-500">Add a photo before exporting.</p>}
        </div>
      </Modal>
    </div>
  );
};

// ===========================================================================
// Root
// ===========================================================================
export default function ContactSheetApp() {
  const [projects, setProjects] = useState<any[]>([]);
  const [view, setView] = useState<'dashboard' | 'editor'>('dashboard');
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [openSheetId, setOpenSheetId] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(true);
  const [toast, setToast] = useState<any>(null);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [previewImg, setPreviewImg] = useState<any>(null);

  const [newProjModal, setNewProjModal] = useState<any>({ open: false, name: '', columns: 4, rows: 6, orientation: 'portrait' });
  const [renameModal, setRenameModal] = useState<any>({ open: false, node: null, name: '' });
  const [deleteNodeModal, setDeleteNodeModal] = useState<any>({ open: false, node: null });
  const [deleteProjModal, setDeleteProjModal] = useState<any>({ open: false, id: null });
  const [settingsModal, setSettingsModal] = useState<any>({ open: false });

  // history (per open project)
  const past = useRef<any[]>([]);
  const future = useRef<any[]>([]);
  const [, forceTick] = useState(0);

  const showToast = (message: string, type = 'info') => setToast({ message, type });
  const openProject = projects.find((p) => p.id === openProjectId) || null;
  const openSheet = openProject && openSheetId ? findNode(openProject.tree, openSheetId) : null;

  useEffect(() => {
    (async () => setProjects(await loadProjectsFromDB()))();
    let dark = true;
    try { const s = localStorage.getItem('cs-theme'); if (s) dark = s === 'dark'; } catch {}
    setIsDark(dark);
    document.documentElement.classList.toggle('dark', dark);
  }, []);

  const toggleTheme = () => setIsDark((prev) => {
    const next = !prev;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('cs-theme', next ? 'dark' : 'light'); } catch {}
    return next;
  });

  const persist = (proj: any) => { setProjects((arr) => arr.map((p) => (p.id === proj.id ? proj : p))); saveProjectToDB(proj); };

  // commit a new version of the open project (with history)
  const commit = useCallback((next: any) => {
    if (!openProject) return;
    past.current = [...past.current.slice(-29), openProject];
    future.current = [];
    const stamped = { ...next, lastModified: Date.now() };
    persist(stamped);
    forceTick((t) => t + 1);
  }, [openProject]);

  const undo = useCallback(() => {
    if (!openProject || past.current.length === 0) return;
    const prev = past.current[past.current.length - 1];
    past.current = past.current.slice(0, -1);
    future.current = [openProject, ...future.current.slice(0, 29)];
    persist(prev);
    forceTick((t) => t + 1);
  }, [openProject]);

  const redo = useCallback(() => {
    if (!openProject || future.current.length === 0) return;
    const nxt = future.current[0];
    future.current = future.current.slice(1);
    past.current = [...past.current.slice(-29), openProject];
    persist(nxt);
    forceTick((t) => t + 1);
  }, [openProject]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== 'editor') return;
      const tag = (document.activeElement as any)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, undo, redo]);

  // sheet mutation helper (used by editor). Special key '__deselect__' clears staging selection.
  const updateSheet = (sheetId: string, fn: ((s: any) => any) | null) => {
    if (!openProject) return;
    if (sheetId === '__deselect__') { commit({ ...openProject, staging: openProject.staging.map((s: any) => ({ ...s, selected: false })) }); return; }
    commit({ ...openProject, tree: updateNode(openProject.tree, sheetId, (s) => fn!(s)) });
  };

  // tree node actions
  const addSheet = () => {
    if (!openProject) return;
    const node = { id: generateId(), type: 'sheet', name: `Sheet ${countSheets(openProject.tree) + 1}`, pages: [{ id: generateId(), items: [] }] };
    commit({ ...openProject, tree: insertNode(openProject.tree, null, node, -1) });
    setOpenSheetId(node.id);
  };
  const addFolder = () => {
    if (!openProject) return;
    const node = { id: generateId(), type: 'folder', name: 'New Folder', children: [] };
    commit({ ...openProject, tree: insertNode(openProject.tree, null, node, -1) });
    setRenameModal({ open: true, node, name: node.name });
  };
  const doRename = () => {
    const name = renameModal.name.trim();
    if (!name || !openProject) return setRenameModal({ open: false, node: null, name: '' });
    commit({ ...openProject, tree: updateNode(openProject.tree, renameModal.node.id, (n) => ({ ...n, name })) });
    setRenameModal({ open: false, node: null, name: '' });
  };
  const doDeleteNode = () => {
    if (!openProject || !deleteNodeModal.node) return;
    const { tree } = removeNode(openProject.tree, deleteNodeModal.node.id);
    if (deleteNodeModal.node.id === openSheetId) setOpenSheetId(null);
    commit({ ...openProject, tree });
    setDeleteNodeModal({ open: false, node: null });
  };

  // settings (writes to open sheet override; re-paginates on grid change)
  const eff = openProject && openSheet ? effSettings(openProject, openSheet) : DEFAULT_SETTINGS;
  const updateSetting = (key: string, value: any) => {
    if (!openProject || !openSheet) return;
    commit({
      ...openProject,
      tree: updateNode(openProject.tree, openSheet.id, (s) => {
        const override = { ...s.settingsOverride, [key]: value };
        let pages = s.pages;
        if (key === 'columns' || key === 'rows') {
          const merged = { ...DEFAULT_SETTINGS, ...openProject.settings, ...override };
          pages = chunkToPages(flatFrames(s), Math.max(1, merged.columns * merged.rows));
        }
        return { ...s, settingsOverride: override, pages };
      }),
    });
  };
  const resetSettings = () => {
    if (!openProject || !openSheet) return;
    commit({
      ...openProject,
      tree: updateNode(openProject.tree, openSheet.id, (s) => {
        const merged = { ...DEFAULT_SETTINGS, ...openProject.settings };
        return { ...s, settingsOverride: undefined, pages: chunkToPages(flatFrames(s), Math.max(1, merged.columns * merged.rows)) };
      }),
    });
    showToast('Reset to project defaults.', 'success');
  };

  // project actions
  const createProject = async () => {
    const name = newProjModal.name.trim() || 'Untitled Project';
    const proj = {
      id: generateId(), name, created: Date.now(), lastModified: Date.now(),
      settings: { ...DEFAULT_SETTINGS, columns: newProjModal.columns, rows: newProjModal.rows, orientation: newProjModal.orientation },
      staging: [], coverPhoto: null,
      tree: [{ id: generateId(), type: 'sheet', name: 'Sheet 1', pages: [{ id: generateId(), items: [] }] }],
    };
    setProjects((a) => [proj, ...a]);
    await saveProjectToDB(proj);
    setNewProjModal({ open: false, name: '', columns: 4, rows: 6, orientation: 'portrait' });
    openProjectAt(proj.id);
  };
  const openProjectAt = (id: string) => {
    past.current = []; future.current = [];
    setOpenProjectId(id);
    const proj = projects.find((p) => p.id === id);
    const firstSheet = proj ? (() => { let f: any = null; walk(proj.tree, (n) => { if (!f && n.type === 'sheet') f = n; }); return f; })() : null;
    setOpenSheetId(firstSheet?.id || null);
    setView('editor');
  };
  const confirmDeleteProject = async () => {
    await deleteProjectFromDB(deleteProjModal.id);
    setProjects((a) => a.filter((p) => p.id !== deleteProjModal.id));
    setDeleteProjModal({ open: false, id: null });
    showToast('Project deleted.', 'success');
  };

  return (
    <div className="h-screen w-full font-sans text-neutral-100 bg-neutral-950 flex overflow-hidden">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {view === 'dashboard' ? (
        <div className="w-full h-full overflow-y-auto">
          <DashboardView projects={projects} isDark={isDark} onToggleTheme={toggleTheme}
            onNewProject={() => setNewProjModal({ open: true, name: '', columns: 4, rows: 6, orientation: 'portrait' })}
            onOpenProject={openProjectAt}
            onDeleteProject={(id: string) => setDeleteProjModal({ open: true, id })} />
        </div>
      ) : openProject ? (
        <div className="flex w-full h-full">
          {/* left rail */}
          <div className="w-14 bg-black flex flex-col items-center py-4 gap-3 no-print border-r border-neutral-800 z-[40]">
            <button onClick={() => { setView('dashboard'); setOpenProjectId(null); setOpenSheetId(null); }} className="text-neutral-400 hover:text-amber-400 p-2.5 rounded-xl hover:bg-neutral-800 transition-colors" title="Back to projects"><ArrowLeft size={22} /></button>
            <div className="w-6 h-px bg-neutral-800" />
            <button onClick={undo} disabled={past.current.length === 0} className="text-neutral-400 hover:text-amber-400 p-2.5 rounded-xl hover:bg-neutral-800 transition-colors disabled:opacity-30" title="Undo (Cmd+Z)"><Undo2 size={20} /></button>
            <button onClick={redo} disabled={future.current.length === 0} className="text-neutral-400 hover:text-amber-400 p-2.5 rounded-xl hover:bg-neutral-800 transition-colors disabled:opacity-30" title="Redo (Cmd+Shift+Z)"><Redo2 size={20} /></button>
            <div className="mt-auto">
              <button onClick={toggleTheme} className="text-neutral-400 hover:text-amber-400 p-2.5 rounded-xl hover:bg-neutral-800 transition-colors" title="Theme">{isDark ? <Sun size={20} /> : <Moon size={20} />}</button>
            </div>
          </div>

          <FinderNav project={openProject} openSheetId={openSheetId} onOpenSheet={setOpenSheetId} onMutate={commit}
            onAddFolder={addFolder} onAddSheet={addSheet}
            onRename={(n: any) => setRenameModal({ open: true, node: n, name: n.name })}
            onDelete={(n: any) => setDeleteNodeModal({ open: true, node: n })} />

          <StagingSidebar project={openProject} onMutate={commit} draggedItem={draggedItem} setDraggedItem={setDraggedItem} hasOpenSheet={!!openSheet} />

          {openSheet ? (
            <SheetEditor project={openProject} sheet={openSheet} eff={eff} updateSheet={updateSheet} onCommit={commit}
              draggedItem={draggedItem} setDraggedItem={setDraggedItem} addToast={showToast} setPreviewImg={setPreviewImg}
              openSettings={() => setSettingsModal({ open: true })} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-neutral-600 bg-neutral-950">
              <FileText size={56} className="mb-4 opacity-20" />
              <p className="text-xl text-neutral-400">Select or create a sheet to start</p>
              <button onClick={addSheet} className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-neutral-950 rounded-xl font-semibold transition-colors"><FilePlus size={17} /> New sheet</button>
            </div>
          )}
        </div>
      ) : null}

      {/* New project */}
      <Modal isOpen={newProjModal.open} onClose={() => setNewProjModal({ ...newProjModal, open: false })} title="New project">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-neutral-400 mb-1.5">Project name</label>
            <input autoFocus value={newProjModal.name} onChange={(e) => setNewProjModal({ ...newProjModal, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && createProject()} placeholder="e.g. Vella Campaign" className="w-full bg-neutral-800 border border-neutral-700 text-white p-3 rounded-xl text-lg focus:ring-2 focus:ring-amber-500 outline-none" />
          </div>
          <p className="text-xs font-mono uppercase tracking-wider text-neutral-500">Default grid (each sheet can override)</p>
          <div className="grid grid-cols-3 gap-3">
            <div><label className="block text-xs text-neutral-400 mb-1">Columns</label><input type="number" min="1" max="10" value={newProjModal.columns} onChange={(e) => setNewProjModal({ ...newProjModal, columns: parseInt(e.target.value) || 1 })} className="w-full bg-neutral-800 border border-neutral-700 text-white p-2 rounded-lg font-mono focus:ring-2 focus:ring-amber-500 outline-none" /></div>
            <div><label className="block text-xs text-neutral-400 mb-1">Rows</label><input type="number" min="1" max="15" value={newProjModal.rows} onChange={(e) => setNewProjModal({ ...newProjModal, rows: parseInt(e.target.value) || 1 })} className="w-full bg-neutral-800 border border-neutral-700 text-white p-2 rounded-lg font-mono focus:ring-2 focus:ring-amber-500 outline-none" /></div>
            <div><label className="block text-xs text-neutral-400 mb-1">Orient.</label><select value={newProjModal.orientation} onChange={(e) => setNewProjModal({ ...newProjModal, orientation: e.target.value })} className="w-full bg-neutral-800 border border-neutral-700 text-white p-2 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></div>
          </div>
          <button onClick={createProject} className="w-full bg-amber-500 text-neutral-950 rounded-lg py-3 font-semibold hover:bg-amber-400 transition-colors">Create project</button>
        </div>
      </Modal>

      {/* Rename */}
      <Modal isOpen={renameModal.open} onClose={() => setRenameModal({ open: false, node: null, name: '' })} title={`Rename ${renameModal.node?.type === 'folder' ? 'folder' : 'sheet'}`}>
        <div className="space-y-4">
          <input autoFocus value={renameModal.name} onChange={(e) => setRenameModal({ ...renameModal, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && doRename()} className="w-full bg-neutral-800 border border-neutral-700 text-white p-3 rounded-xl text-lg focus:ring-2 focus:ring-amber-500 outline-none" />
          <button onClick={doRename} className="w-full bg-amber-500 text-neutral-950 rounded-lg py-3 font-semibold hover:bg-amber-400 transition-colors">Rename</button>
        </div>
      </Modal>

      {/* Delete node */}
      <Modal isOpen={deleteNodeModal.open} onClose={() => setDeleteNodeModal({ open: false, node: null })} title={`Delete ${deleteNodeModal.node?.type === 'folder' ? 'folder' : 'sheet'}?`}>
        <div className="space-y-4">
          <p className="text-neutral-300">{deleteNodeModal.node?.type === 'folder' ? 'This deletes the folder and everything inside it.' : 'This deletes the sheet and all its pages.'} This can’t be undone with Cmd+Z after you leave the project.</p>
          <div className="flex gap-3">
            <button onClick={() => setDeleteNodeModal({ open: false, node: null })} className="flex-1 bg-neutral-700 text-white rounded-lg py-3 font-medium hover:bg-neutral-600 transition-colors">Cancel</button>
            <button onClick={doDeleteNode} className="flex-1 bg-red-600 text-white rounded-lg py-3 font-medium hover:bg-red-700 transition-colors">Delete</button>
          </div>
        </div>
      </Modal>

      {/* Delete project */}
      <Modal isOpen={deleteProjModal.open} onClose={() => setDeleteProjModal({ open: false, id: null })} title="Delete project?">
        <div className="space-y-4">
          <p className="text-neutral-300">This permanently removes the project and everything in it.</p>
          <div className="flex gap-3">
            <button onClick={() => setDeleteProjModal({ open: false, id: null })} className="flex-1 bg-neutral-700 text-white rounded-lg py-3 font-medium hover:bg-neutral-600 transition-colors">Cancel</button>
            <button onClick={confirmDeleteProject} className="flex-1 bg-red-600 text-white rounded-lg py-3 font-medium hover:bg-red-700 transition-colors">Delete</button>
          </div>
        </div>
      </Modal>

      {/* Sheet settings */}
      <Modal isOpen={settingsModal.open} onClose={() => setSettingsModal({ open: false })} title="Sheet settings">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm text-neutral-300 mb-1">Orientation</label>
              <select value={eff.orientation} onChange={(e) => updateSetting('orientation', e.target.value)} className="w-full bg-neutral-800 border border-neutral-700 text-white p-2 rounded-lg focus:ring-2 focus:ring-amber-500 outline-none"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select>
            </div>
            <div><label className="block text-sm text-neutral-300 mb-1">Sheet color</label>
              <input type="color" value={eff.bgColor} onChange={(e) => updateSetting('bgColor', e.target.value)} className="w-full h-[42px] rounded-lg cursor-pointer bg-neutral-800 p-1 border border-neutral-700" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm text-neutral-300 mb-1">Columns</label><input type="number" min="1" max="10" value={eff.columns} onChange={(e) => updateSetting('columns', parseInt(e.target.value) || 1)} className="w-full bg-neutral-800 border border-neutral-700 text-white p-2 rounded-lg font-mono focus:ring-2 focus:ring-amber-500 outline-none" /></div>
            <div><label className="block text-sm text-neutral-300 mb-1">Rows</label><input type="number" min="1" max="15" value={eff.rows} onChange={(e) => updateSetting('rows', parseInt(e.target.value) || 1)} className="w-full bg-neutral-800 border border-neutral-700 text-white p-2 rounded-lg font-mono focus:ring-2 focus:ring-amber-500 outline-none" /></div>
          </div>
          <label className="flex items-center justify-between py-1 cursor-pointer">
            <span className="text-sm text-neutral-300">Show filenames</span>
            <input type="checkbox" checked={eff.showFileNames} onChange={(e) => updateSetting('showFileNames', e.target.checked)} className="w-5 h-5 accent-amber-500" />
          </label>
          {eff.showFileNames && (
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-xs text-neutral-400 mb-1">Label size {eff.fileNameSize}px</label><input type="range" min="7" max="20" value={eff.fileNameSize} onChange={(e) => updateSetting('fileNameSize', parseInt(e.target.value))} className="w-full accent-amber-500" /></div>
              <div><label className="block text-xs text-neutral-400 mb-1">Bar opacity {eff.fileNameOpacity}%</label><input type="range" min="0" max="100" value={eff.fileNameOpacity} onChange={(e) => updateSetting('fileNameOpacity', parseInt(e.target.value))} className="w-full accent-amber-500" /></div>
            </div>
          )}
          <div className="flex gap-3 pt-2 border-t border-neutral-800">
            <button onClick={resetSettings} className="flex-1 bg-neutral-800 text-neutral-300 rounded-lg py-2.5 font-medium hover:bg-neutral-700 transition-colors text-sm">Reset to project defaults</button>
            <button onClick={() => setSettingsModal({ open: false })} className="flex-1 bg-amber-500 text-neutral-950 rounded-lg py-2.5 font-semibold hover:bg-amber-400 transition-colors">Done</button>
          </div>
        </div>
      </Modal>

      {previewImg && <Lightbox img={previewImg} onClose={() => setPreviewImg(null)} />}
    </div>
  );
}
