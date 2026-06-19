import React, { useState, useEffect, useRef } from 'react';
import {
  FolderPlus, Image as ImageIcon, Trash2, Settings, ArrowRight,
  UploadCloud, FileDown, CheckSquare, Plus, Type, X, Search, Sun, Moon,
  LayoutGrid, Maximize, Minimize, Aperture
} from 'lucide-react';

/* =============================================================================
   Contact Sheets — a darkroom-style proof-sheet builder.
   Part of the same production suite as Mood Board: dark, cinematic chrome,
   monospace metadata (the film-counter signature), warm safelight accent.
   ========================================================================== */


// Robust ID generator (avoids crashes where crypto.randomUUID is unavailable)
const generateId = () => {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID();
  }
  return Math.random().toString(36).substring(2, 15);
};

// --- IndexedDB persistence layer ---
const DB_NAME = 'ContactSheetDB';
const STORE_NAME = 'projects';
const DB_VERSION = 1;

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e: any) => {
      const db = e.target.result as IDBDatabase;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const loadProjectsFromDB = async (): Promise<any[]> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('DB Load Error', e);
    return [];
  }
};

const saveProjectToDB = async (project: any) => {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      project.lastModified = Date.now();
      const request = store.put(project);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('DB Save Error', e);
  }
};

const deleteProjectFromDB = async (id: string) => {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (e) {
    console.error('DB Delete Error', e);
  }
};

// Downscale large uploads before storing, to keep the DB light and avoid crashes
const downscaleImage = (file: File): Promise<string> => {
  return new Promise((resolve) => {
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
        const ctx = canvas.getContext('2d');
        ctx!.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
};

// --- Runtime loaders for export libraries (loaded only when exporting) ---
const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (Array.from(document.scripts).some((s) => s.src === src)) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(el);
  });

// html2canvas-pro parses modern CSS color functions (oklch/lab) that Tailwind
// emits — plain html2canvas throws on those, which broke the old export.
const loadHtml2Canvas = async () => {
  const w = window as any;
  if (!w.html2canvas) {
    await loadScript('https://cdn.jsdelivr.net/npm/html2canvas-pro@2.0.4/dist/html2canvas-pro.min.js');
  }
  return w.html2canvas.default || w.html2canvas;
};

const loadJsPDF = async () => {
  const w = window as any;
  if (!w.jspdf) {
    await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js');
  }
  return w.jspdf;
};

const nextPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// =============================================================================
// Shared UI
// =============================================================================

const Modal = ({ isOpen, onClose, title, children }: any) => {
  // Close on Escape while open
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // High z-index instead of a portal (the artifact runtime doesn't expose
  // react-dom). z-[1000] sits above every editor layer, so nothing from the
  // page can paint over it.
  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[1000] flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col border border-neutral-200 dark:border-neutral-800 transition-colors"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-neutral-200 dark:border-neutral-800 flex justify-between items-center bg-neutral-50 dark:bg-neutral-950 transition-colors">
          <h3 className="font-semibold text-lg text-neutral-900 dark:text-white tracking-tight">{title}</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
            <X size={20} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
};

// Full-screen image zoom. Esc or a click anywhere closes it.
const Lightbox = ({ img, onClose }: any) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1100] bg-black/95 backdrop-blur-md flex flex-col items-center justify-center p-8 cursor-zoom-out" onMouseDown={onClose}>
      <button
        onClick={onClose}
        className="absolute top-5 right-5 flex items-center gap-2 text-white/90 bg-white/10 hover:bg-white/20 rounded-full pl-4 pr-3 py-2 text-sm font-medium transition-colors"
      >
        Close <X size={18} />
      </button>
      <img src={img.data} alt="" className="max-w-full max-h-full object-contain drop-shadow-2xl rounded-sm cursor-default" onMouseDown={(e) => e.stopPropagation()} />
      {img.filename && (
        <div className="absolute bottom-8 px-4 py-2 bg-black/70 text-white rounded-lg text-sm font-mono tracking-wide pointer-events-none">{img.filename}</div>
      )}
      <div className="absolute bottom-2 left-0 right-0 text-center text-white/40 text-xs pointer-events-none">Press Esc or click anywhere to close</div>
    </div>
  );
};

const Toast = ({ message, type = 'info', onClose }: any) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const accentBar =
    type === 'error' ? 'border-l-red-500' : type === 'success' ? 'border-l-amber-500' : 'border-l-neutral-600';

  return (
    <div
      className={`fixed bottom-4 right-4 pl-4 pr-6 py-3 rounded-xl shadow-2xl text-white font-medium z-[210] bg-neutral-900 border border-neutral-700 border-l-4 ${accentBar} transition-all`}
    >
      {message}
    </div>
  );
};

// =============================================================================
// Dashboard
// =============================================================================

const DashboardView = ({ onOpenProject, onTriggerNewProject, projects, onTriggerDeleteProject, isDark, onToggleTheme }: any) => {
  const [searchTerm, setSearchTerm] = useState('');
  const filteredProjects = projects.filter((p: any) => p.name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 p-8 transition-colors">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">
        <div className="flex justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="h-11 w-11 rounded-xl bg-amber-500 text-neutral-950 flex items-center justify-center shadow-sm shrink-0">
              <Aperture size={24} strokeWidth={2.25} />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-neutral-900 dark:text-white tracking-tight">Contact Sheets</h1>
              <p className="text-neutral-500 dark:text-neutral-400 mt-0.5 font-mono text-xs uppercase tracking-[0.2em]">
                Proof &amp; layout · {projects.length} {projects.length === 1 ? 'project' : 'projects'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onToggleTheme}
              className="text-neutral-500 dark:text-neutral-400 hover:text-amber-500 dark:hover:text-amber-400 p-2.5 rounded-xl hover:bg-neutral-100 dark:hover:bg-neutral-900 transition-colors"
              title={isDark ? 'Switch to light' : 'Switch to dark'}
            >
              {isDark ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <button
              onClick={onTriggerNewProject}
              className="bg-amber-500 hover:bg-amber-400 text-neutral-950 px-6 py-3 rounded-xl font-semibold transition-colors shadow-sm flex items-center gap-2"
            >
              <FolderPlus size={20} /> New project
            </button>
          </div>
        </div>

        <div className="bg-white dark:bg-neutral-900 p-4 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-800 flex gap-4 items-center transition-colors">
          <Search className="text-neutral-400 ml-2" size={20} />
          <input
            type="text"
            placeholder="Search projects…"
            className="flex-1 outline-none text-neutral-700 dark:text-neutral-200 bg-transparent placeholder:text-neutral-400"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProjects.length === 0 ? (
            <div className="col-span-full py-16 text-center text-neutral-400 border-2 border-dashed border-neutral-200 dark:border-neutral-800 rounded-3xl">
              <Aperture size={48} className="mx-auto mb-4 opacity-40" />
              <p className="text-lg">No projects yet. Create one to start laying out frames.</p>
            </div>
          ) : (
            filteredProjects.map((project: any) => {
              const coverData =
                project.coverPhoto || project.staging?.[0]?.data || project.pages?.[0]?.items?.find((i: any) => i.type === 'image')?.data;
              const frameCount = project.pages.reduce(
                (n: number, p: any) => n + p.items.filter((i: any) => i.type === 'image').length,
                0
              );
              return (
                <div
                  key={project.id}
                  className="bg-white dark:bg-neutral-900 rounded-2xl shadow-sm border border-neutral-200 dark:border-neutral-800 overflow-hidden hover:shadow-md hover:border-neutral-300 dark:hover:border-neutral-700 transition-all group flex flex-col"
                >
                  <div
                    className="h-40 bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center cursor-pointer relative overflow-hidden"
                    onClick={() => onOpenProject(project)}
                  >
                    {coverData ? (
                      <img src={coverData} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                    ) : (
                      <>
                        <div className="absolute inset-0 grid grid-cols-4 grid-rows-4 gap-0.5 p-2 opacity-20">
                          {Array.from({ length: 16 }).map((_, i) => (
                            <div key={i} className="bg-neutral-400 dark:bg-neutral-500 rounded-sm"></div>
                          ))}
                        </div>
                        <Aperture size={36} className="text-neutral-300 dark:text-neutral-600 relative z-10 group-hover:scale-110 transition-transform" />
                      </>
                    )}
                  </div>
                  <div className="p-5 flex justify-between items-start">
                    <div className="cursor-pointer flex-1 min-w-0" onClick={() => onOpenProject(project)}>
                      <h3 className="font-semibold text-lg text-neutral-800 dark:text-white line-clamp-1">{project.name}</h3>
                      <p className="text-xs font-mono uppercase tracking-wider text-neutral-500 mt-1.5">
                        {new Date(project.lastModified).toLocaleDateString()} · {project.pages.length}P · {frameCount}F
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTriggerDeleteProject(project.id);
                      }}
                      className="text-neutral-400 hover:text-red-500 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                      title="Delete project"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// Editor — staging sidebar
// =============================================================================

const EditorSidebar = ({ project, updateProject, draggedItem, setDraggedItem, addToast }: any) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  const handleFileUpload = async (e: any) => {
    const files = Array.from(e.target.files) as File[];
    if (!files.length) return;
    const newImages: any[] = [];
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const dataUrl = await downscaleImage(file);
        newImages.push({ id: generateId(), type: 'image', data: dataUrl, selected: false, filename: file.name });
      }
    }
    updateProject({ staging: [...project.staging, ...newImages] });
    e.target.value = '';
  };

  const toggleSelection = (index: number, event: any) => {
    const newStaging = [...project.staging];
    if (event.shiftKey && lastClickedIndex !== null) {
      const start = Math.min(index, lastClickedIndex);
      const end = Math.max(index, lastClickedIndex);
      for (let i = start; i <= end; i++) newStaging[i].selected = true;
    } else {
      newStaging[index].selected = !newStaging[index].selected;
      setLastClickedIndex(index);
    }
    updateProject({ staging: newStaging });
  };

  const selectAll = () => {
    const allSelected = project.staging.every((i: any) => i.selected);
    updateProject({ staging: project.staging.map((i: any) => ({ ...i, selected: !allSelected })) });
  };

  const deleteSelectedStaging = () => {
    updateProject({ staging: project.staging.filter((i: any) => !i.selected) });
    setLastClickedIndex(null);
  };

  const selectedCount = project.staging.filter((i: any) => i.selected).length;

  return (
    <div className="w-80 bg-white dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800 flex flex-col h-full z-10 no-print shadow-sm transition-colors">
      <div className="p-5 border-b border-neutral-100 dark:border-neutral-800">
        <h2 className="font-semibold flex items-center gap-2 text-neutral-800 dark:text-white mb-4">
          <ImageIcon size={18} className="text-amber-500 dark:text-amber-400" /> Staging
          <span className="ml-auto font-mono text-xs text-neutral-400 tabular-nums">{project.staging.length}</span>
        </h2>

        <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 py-2.5 rounded-xl font-medium transition-colors flex justify-center items-center gap-2 border border-amber-200 dark:border-amber-500/20"
        >
          <UploadCloud size={18} /> Upload photos
        </button>

        <div className="mt-4 flex gap-2 text-sm">
          <button
            onClick={selectAll}
            className="flex-1 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 py-1.5 rounded-full font-medium transition-colors"
          >
            {selectedCount === project.staging.length && selectedCount > 0 ? 'Deselect all' : 'Select all'}
          </button>
          {selectedCount > 0 && (
            <button
              onClick={deleteSelectedStaging}
              className="px-4 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 text-red-600 dark:text-red-400 py-1.5 rounded-full font-medium transition-colors"
            >
              Delete ({selectedCount})
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 bg-neutral-50/60 dark:bg-neutral-950 transition-colors">
        {project.staging.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-neutral-400 p-4 text-center">
            <ImageIcon size={32} className="mb-2 opacity-20" />
            <p className="text-sm">Upload photos and they’ll stage here, ready to drop onto a sheet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {project.staging.map((img: any, index: number) => {
              const isUsed = project.pages.some((p: any) => p.items.some((pi: any) => pi.data === img.data));
              return (
                <div
                  key={img.id}
                  draggable
                  onDragStart={() => setDraggedItem({ source: 'staging', item: img })}
                  onDragEnd={() => setDraggedItem(null)}
                  onClick={(e) => toggleSelection(index, e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    updateProject({ coverPhoto: img.data });
                    addToast('Set as project cover.', 'success');
                  }}
                  className={`aspect-square rounded-xl cursor-pointer bg-cover bg-center border-2 transition-all shadow-sm overflow-hidden relative
                    ${img.selected ? 'border-amber-400 ring-2 ring-amber-500/30 scale-95' : 'border-transparent hover:border-neutral-300 dark:hover:border-neutral-600'}
                    ${draggedItem?.item?.id === img.id ? 'opacity-50 grayscale ring-4 ring-amber-500 z-10' : 'opacity-100'}`}
                  style={{ backgroundImage: `url(${img.data})` }}
                  title={img.filename}
                >
                  {isUsed && (
                    <div className="absolute inset-0 bg-neutral-950/40 flex items-center justify-center pointer-events-none">
                      <span className="bg-neutral-900 text-amber-300 text-[10px] uppercase font-mono font-bold tracking-wider px-1.5 py-0.5 rounded shadow-sm">Placed</span>
                    </div>
                  )}
                  {img.selected && (
                    <div className="absolute top-2 right-2 bg-amber-500 text-neutral-950 rounded-full p-0.5 shadow-md z-10 pointer-events-none">
                      <CheckSquare size={14} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="p-3 border-t border-neutral-100 dark:border-neutral-800 text-[11px] text-neutral-400 font-mono uppercase tracking-wider text-center">
        Double-click to zoom · right-click to set cover
      </div>
    </div>
  );
};

// =============================================================================
// Editor — main canvas
// =============================================================================

const EditorMain = ({ project, updateProject, draggedItem, setDraggedItem, addToast, setPreviewImg, isDark, onToggleTheme }: any) => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [pageTitleModal, setPageTitleModal] = useState<any>({ isOpen: false, pageId: null, text: '' });
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
  const [dragOverPageId, setDragOverPageId] = useState<string | null>(null);
  const [isClearOpen, setIsClearOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // PDF export state
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportQuality, setExportQuality] = useState(85);
  const [isExporting, setIsExporting] = useState(false);

  const toggleFullscreen = () => setIsFullscreen(!isFullscreen);

  // Capacity = image cells only. Titles render as a slim band outside the grid,
  // so they no longer consume photo slots.
  const getPageCapacityInfo = (page: any) => {
    const maxCapacity = project.settings.columns * project.settings.rows;
    const currentCount = page.items.filter((i: any) => i.type === 'image').length;
    return { max: maxCapacity, current: currentCount, remaining: Math.max(0, maxCapacity - currentCount) };
  };

  const clearAllPages = () => {
    updateProject({ pages: project.pages.map((p: any) => ({ ...p, items: [] })) });
    setIsClearOpen(false);
    addToast('Cleared all photos from every page.', 'success');
  };

  const handleDropOnItem = (e: any, targetPageId: string, targetItemId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedItem) return;

    let newPages = [...project.pages];
    let itemsToMove: any[] = [];

    if (draggedItem.source === 'staging') {
      const isSelected = project.staging.find((i: any) => i.id === draggedItem.item.id)?.selected;
      const stagingItems = isSelected ? project.staging.filter((i: any) => i.selected) : [draggedItem.item];
      itemsToMove = stagingItems.map((i: any) => ({ id: generateId(), type: 'image', data: i.data, filename: i.filename }));
      updateProject({ staging: project.staging.map((i: any) => ({ ...i, selected: false })) });
    } else if (draggedItem.source === 'page') {
      if (draggedItem.pageId === targetPageId && draggedItem.item.id === targetItemId) {
        setDraggedItem(null);
        setDragOverItemId(null);
        return;
      }
      itemsToMove = [draggedItem.item];
      const sourcePageIdx = newPages.findIndex((p) => p.id === draggedItem.pageId);
      newPages[sourcePageIdx] = {
        ...newPages[sourcePageIdx],
        items: newPages[sourcePageIdx].items.filter((i: any) => i.id !== draggedItem.item.id),
      };
    }

    const targetPageIdx = newPages.findIndex((p) => p.id === targetPageId);
    const targetItems = [...newPages[targetPageIdx].items];
    const insertIdx = targetItems.findIndex((i: any) => i.id === targetItemId);
    if (insertIdx !== -1) targetItems.splice(insertIdx, 0, ...itemsToMove);
    else targetItems.push(...itemsToMove);

    newPages[targetPageIdx] = { ...newPages[targetPageIdx], items: targetItems };
    updateProject({ pages: newPages });
    setDraggedItem(null);
    setDragOverItemId(null);
  };

  const handleDropOnPage = (e: any, targetPageId: string) => {
    e.preventDefault();
    if (!draggedItem) return;

    let newPages = [...project.pages];
    let itemsToMove: any[] = [];

    if (draggedItem.source === 'staging') {
      const isSelected = project.staging.find((i: any) => i.id === draggedItem.item.id)?.selected;
      const stagingItems = isSelected ? project.staging.filter((i: any) => i.selected) : [draggedItem.item];
      itemsToMove = stagingItems.map((i: any) => ({ id: generateId(), type: 'image', data: i.data, filename: i.filename }));
      updateProject({ staging: project.staging.map((i: any) => ({ ...i, selected: false })) });
    } else if (draggedItem.source === 'page') {
      itemsToMove = [draggedItem.item];
      const sourcePageIdx = newPages.findIndex((p) => p.id === draggedItem.pageId);
      newPages[sourcePageIdx] = {
        ...newPages[sourcePageIdx],
        items: newPages[sourcePageIdx].items.filter((i: any) => i.id !== draggedItem.item.id),
      };
    }

    const targetPageIdx = newPages.findIndex((p) => p.id === targetPageId);
    newPages[targetPageIdx] = { ...newPages[targetPageIdx], items: [...newPages[targetPageIdx].items, ...itemsToMove] };
    updateProject({ pages: newPages });
    setDraggedItem(null);
  };

  const autoFillSelected = () => {
    const selected = project.staging.filter((i: any) => i.selected);
    if (selected.length === 0) return addToast('Select photos first, then auto-fill.', 'error');

    let newPages = [...project.pages];
    let i = 0;
    let safety = 0;
    while (i < selected.length && safety < 1000) {
      safety++;
      let targetPageIdx = newPages.findIndex((p) => getPageCapacityInfo(p).remaining > 0);
      if (targetPageIdx === -1) {
        newPages.push({ id: generateId(), items: [] });
        targetPageIdx = newPages.length - 1;
      }
      const targetPage = newPages[targetPageIdx];
      const capacity = getPageCapacityInfo(targetPage);
      const batch = selected
        .slice(i, i + capacity.remaining)
        .map((img: any) => ({ id: generateId(), type: 'image', data: img.data, filename: img.filename }));
      newPages[targetPageIdx] = { ...targetPage, items: [...targetPage.items, ...batch] };
      i += batch.length;
    }

    updateProject({
      staging: project.staging.map((img: any) => ({ ...img, selected: false })),
      pages: newPages,
    });
    addToast(`Placed ${selected.length} ${selected.length === 1 ? 'photo' : 'photos'}.`, 'success');
  };

  const addPage = () => updateProject({ pages: [...project.pages, { id: generateId(), items: [] }] });

  const removePage = (pageId: string) => {
    if (project.pages.length === 1) return addToast('A project needs at least one page.', 'error');
    updateProject({ pages: project.pages.filter((p: any) => p.id !== pageId) });
  };

  const removePageItem = (pageId: string, itemId: string) => {
    updateProject({
      pages: project.pages.map((p: any) =>
        p.id === pageId ? { ...p, items: p.items.filter((i: any) => i.id !== itemId) } : p
      ),
    });
  };

  const submitPageTitle = () => {
    if (!pageTitleModal.text.trim()) return;
    updateProject({
      pages: project.pages.map((p: any) =>
        p.id === pageTitleModal.pageId
          ? { ...p, items: [{ id: generateId(), type: 'title', text: pageTitleModal.text }, ...p.items] }
          : p
      ),
    });
    setPageTitleModal({ isOpen: false, pageId: null, text: '' });
  };

  // --- PDF EXPORT (rebuilt) -------------------------------------------------
  // Each sheet is captured on its own and dropped full-bleed onto its own PDF
  // page. One sheet = one page, so nothing can be sliced across a boundary.
  const handleExportPDF = async () => {
    setIsExporting(true);
    addToast('Building your PDF…', 'info');

    // Let the export re-render strip UI chrome + empty pages before capture
    await nextPaint();
    await new Promise((r) => setTimeout(r, 200));

    // `stage` is reported in the error toast/console so any failure is
    // pinpointed to libraries / a specific page / saving — not a mystery.
    let stage = 'starting';
    try {
      stage = 'loading export libraries';
      const html2canvas = await loadHtml2Canvas();
      const { jsPDF } = await loadJsPDF();
      if (typeof html2canvas !== 'function') throw new Error('html2canvas did not load');
      if (typeof jsPDF !== 'function') throw new Error('jsPDF did not load');

      const isPortrait = project.settings.orientation !== 'landscape';
      const orientation = isPortrait ? 'portrait' : 'landscape';
      const pdf = new jsPDF({ unit: 'in', format: 'letter', orientation });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();

      const wrappers = Array.from(document.querySelectorAll('[data-export-page="true"]')) as HTMLElement[];
      if (!wrappers.length) throw new Error('No sheets with photos to export');

      // Adaptive, *bounded* resolution. The old fixed 3x blew up memory on
      // multi-page projects (every page is held until save) and crashed the
      // tab. Target ~150–200 DPI on Letter and cap the multiplier at 2x.
      const targetPx = exportQuality >= 80 ? 1700 : 1275;

      let added = 0;
      for (let i = 0; i < wrappers.length; i++) {
        stage = `rendering page ${i + 1} of ${wrappers.length}`;
        const el = wrappers[i];
        const baseWidth = el.offsetWidth || (isPortrait ? 850 : 1100);
        const scale = Math.min(2, Math.max(1, targetPx / baseWidth));

        const canvas = await html2canvas(el, {
          scale,
          useCORS: true,
          logging: false,
          backgroundColor: project.settings.bgColor || '#000000',
          imageTimeout: 15000,
          removeContainer: true,
        });
        const imgData = canvas.toDataURL('image/jpeg', exportQuality / 100);

        // Release this page's canvas before building the next one
        canvas.width = 0;
        canvas.height = 0;

        if (added > 0) pdf.addPage('letter', orientation);
        // wrapper aspect ratio == letter aspect ratio, so full-bleed is exact
        pdf.addImage(imgData, 'JPEG', 0, 0, pageW, pageH, undefined, 'FAST');
        added++;

        // Yield to the event loop so the tab stays responsive and memory can
        // be reclaimed between pages.
        await new Promise((r) => setTimeout(r, 0));
      }

      stage = 'saving file';
      const filename = (project.name || 'Contact_Sheet').replace(/\s+/g, '_');
      pdf.save(`${filename}.pdf`);
      addToast('PDF saved.', 'success');
    } catch (error) {
      console.error(`PDF export failed while: ${stage}`, error);
      addToast(`Export failed while ${stage}. See the browser console for details.`, 'error');
    } finally {
      setIsExporting(false);
      setIsExportModalOpen(false);
    }
  };

  const allUsedData = project.pages.flatMap((p: any) =>
    p.items.filter((i: any) => i.type === 'image').map((i: any) => i.data)
  );
  const totalImages = allUsedData.length;
  const nonEmptyPages = project.pages.filter((p: any) => p.items.length > 0).length;
  const estimatedSizeMB = (Math.max(1, totalImages) * 0.28 * (exportQuality / 100)).toFixed(1);
  const imageScale = project.settings.imageScale || 95;
  const isPortrait = project.settings.orientation !== 'landscape';
  const maxWidthClass = isPortrait ? 'max-w-[850px]' : 'max-w-[1100px]';
  const aspectClass = isPortrait ? 'aspect-[8.5/11]' : 'aspect-[11/8.5]';

  return (
    <div className={isFullscreen ? 'fixed inset-0 z-[100] flex flex-col bg-neutral-100 dark:bg-neutral-950 transition-colors' : 'flex-1 flex flex-col bg-neutral-100 dark:bg-neutral-950 h-full relative transition-colors'}>
      {/* Primary toolbar */}
      <div className="h-16 bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between px-6 no-print shadow-sm z-20 transition-colors shrink-0">
        <div className="flex items-center gap-4">
          <input
            type="text"
            value={project.name}
            onChange={(e) => updateProject({ name: e.target.value })}
            className="text-xl font-bold bg-transparent outline-none hover:bg-neutral-50 dark:hover:bg-neutral-800 focus:bg-neutral-50 dark:focus:bg-neutral-800 px-2 py-1 rounded transition-colors text-neutral-800 dark:text-white border border-transparent focus:border-neutral-200 dark:focus:border-neutral-700 w-64"
            placeholder="Project name"
          />
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 border-r border-neutral-300 dark:border-neutral-700">
            <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">Scale</span>
            <input
              type="range"
              min="10"
              max="100"
              value={imageScale}
              onChange={(e) => updateProject({ settings: { ...project.settings, imageScale: parseInt(e.target.value) } })}
              className="w-24 accent-amber-500"
            />
            <div className="flex items-center bg-neutral-100 dark:bg-neutral-800 rounded px-2 py-1">
              <input
                type="number"
                min="10"
                max="100"
                value={imageScale}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (isNaN(val)) return;
                  updateProject({ settings: { ...project.settings, imageScale: Math.min(100, Math.max(10, val)) } });
                }}
                className="w-10 bg-transparent text-sm text-center outline-none text-neutral-800 dark:text-neutral-200 font-mono tabular-nums"
              />
              <span className="text-sm text-neutral-500 dark:text-neutral-400 -ml-1">%</span>
            </div>
          </div>

          <button onClick={onToggleTheme} className="text-neutral-600 dark:text-neutral-400 hover:text-amber-500 p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors" title={isDark ? 'Switch to light' : 'Switch to dark'}>
            {isDark ? <Sun size={20} /> : <Moon size={20} />}
          </button>

          <button onClick={toggleFullscreen} className="text-neutral-600 dark:text-neutral-400 hover:text-amber-500 p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors" title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
            {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>

          <button onClick={autoFillSelected} className="bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 px-4 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2 border border-amber-200 dark:border-amber-500/20" title="Flow selected photos into pages">
            <ArrowRight size={16} /> Auto-fill
          </button>

          <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-700 mx-1"></div>

          <button onClick={() => setIsClearOpen(true)} className="text-neutral-600 dark:text-neutral-400 hover:text-red-500 p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors" title="Remove all photos from every page">
            <Trash2 size={20} />
          </button>

          <button onClick={() => setIsSettingsOpen(true)} className="text-neutral-600 dark:text-neutral-400 hover:text-amber-500 p-2 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors" title="Grid settings">
            <Settings size={20} />
          </button>

          <button onClick={() => setIsExportModalOpen(true)} className="bg-amber-500 hover:bg-amber-400 text-neutral-950 px-5 py-2 rounded-lg font-semibold transition-colors flex items-center gap-2 shadow-sm">
            <FileDown size={18} /> Export PDF
          </button>
        </div>
      </div>

      {/* Secondary toolbar: filename overlays */}
      <div className="h-12 bg-neutral-50 dark:bg-neutral-900/50 border-b border-neutral-200 dark:border-neutral-800 flex items-center px-6 gap-8 no-print z-10 transition-colors shrink-0">
        <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-neutral-700 dark:text-neutral-300">
          <input type="checkbox" checked={project.settings.showFileNames || false} onChange={(e) => updateProject({ settings: { ...project.settings, showFileNames: e.target.checked } })} className="w-4 h-4 accent-amber-500 rounded cursor-pointer" />
          Show filenames
        </label>

        {project.settings.showFileNames && (
          <div className="flex gap-8 border-l border-neutral-300 dark:border-neutral-700 pl-8">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Banner opacity</span>
              <input type="range" min="0" max="100" value={project.settings.fileNameOpacity !== undefined ? project.settings.fileNameOpacity : 70} onChange={(e) => updateProject({ settings: { ...project.settings, fileNameOpacity: parseInt(e.target.value) } })} className="w-24 accent-amber-500" />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Text size</span>
              <input type="range" min="8" max="24" value={project.settings.fileNameSize || 12} onChange={(e) => updateProject({ settings: { ...project.settings, fileNameSize: parseInt(e.target.value) } })} className="w-24 accent-amber-500" />
            </div>
          </div>
        )}
      </div>

      {/* Workspace */}
      <div className="flex-1 overflow-y-auto p-8 flex flex-col items-center gap-12 print-container relative">
        <style
          dangerouslySetInnerHTML={{
            __html: `
            @media (prefers-reduced-motion: reduce) {
              * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
            }
            :focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
            @media print {
              @page { margin: 0; size: auto; }
              body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: white !important; }
              .no-print { display: none !important; }
              .print-container { padding: 0 !important; background: transparent !important; display: block !important; }
              .page-wrapper { margin: 0 !important; page-break-after: always; box-shadow: none !important; border: none !important; max-width: none !important; width: 100% !important; border-radius: 0 !important; }
              .page-wrapper:last-child { page-break-after: auto; }
            }
          `,
          }}
        />

        {project.pages.map((page: any, index: number) => {
          if (isExporting && page.items.length === 0) return null;
          const capacity = getPageCapacityInfo(page);
          const isOverCapacity = capacity.remaining === 0 && capacity.current > 0;
          const titleItems = page.items.filter((i: any) => i.type === 'title');
          const imageItems = page.items.filter((i: any) => i.type === 'image');

          return (
            <div key={page.id} className={`flex flex-col w-full items-center gap-2 ${maxWidthClass}`}>
              {!isExporting && (
                <div className="w-full flex justify-between items-end mb-1 px-1 no-print">
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono font-bold text-neutral-500 dark:text-neutral-400 uppercase tracking-[0.2em] text-sm">
                      Page {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="font-mono text-xs text-neutral-400 dark:text-neutral-600 tabular-nums">
                      {capacity.current}/{capacity.max}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setPageTitleModal({ isOpen: true, pageId: page.id, text: '' })} className="flex items-center gap-1 text-xs font-semibold bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 px-3 py-1.5 rounded-md shadow-sm border border-neutral-200 dark:border-neutral-700 hover:text-amber-600 dark:hover:text-amber-400 transition-colors">
                      <Type size={14} /> Add title
                    </button>
                    <button onClick={() => removePage(page.id)} className="flex items-center gap-1 text-xs font-semibold bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 px-3 py-1.5 rounded-md shadow-sm border border-neutral-200 dark:border-neutral-700 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                      <Trash2 size={14} /> Delete page
                    </button>
                  </div>
                </div>
              )}

              <div
                data-export-page="true"
                className={`relative group page-wrapper w-full ${aspectClass} overflow-hidden p-8 flex flex-col transition-[box-shadow,border-color] ${
                  isExporting
                    ? ''
                    : 'shadow-2xl border ' +
                      (draggedItem && dragOverPageId === page.id
                        ? 'border-amber-400 ring-2 ring-amber-400/40'
                        : 'border-neutral-300 dark:border-neutral-800')
                }`}
                style={{ backgroundColor: project.settings.bgColor || '#000000' }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  if (dragOverPageId !== page.id) setDragOverPageId(page.id);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setDragOverPageId(null);
                }}
                onDrop={(e) => {
                  setDragOverPageId(null);
                  setDragOverItemId(null);
                  handleDropOnPage(e, page.id);
                }}
              >
                {/* Title bands — slim full-width strips, sized to their content */}
                {titleItems.map((t: any) => (
                  <div key={t.id} className="relative w-full shrink-0 bg-neutral-950 text-white px-6 py-2.5 mb-px flex items-center border-b border-neutral-800">
                    <div className="flex-1 font-mono font-bold text-sm sm:text-base uppercase tracking-[0.25em] text-center">{t.text}</div>
                    {!isExporting && (
                      <button onClick={() => removePageItem(page.id, t.id)} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-red-400 no-print" title="Remove title">
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}

                {/* Image grid: fixed rows/cols so images scale to fit and a full
                    sheet maps exactly to one PDF page (no overflow). */}
                <div
                  className="flex-1 min-h-0 w-full grid gap-0 place-content-start"
                  style={{
                    gridTemplateColumns: `repeat(${project.settings.columns}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${project.settings.rows}, minmax(0, 1fr))`,
                  }}
                >
                  {imageItems.map((item: any) => {
                    const isDuplicate = allUsedData.filter((d: any) => d === item.data).length > 1;
                    const isBeingDragged = draggedItem?.item?.id === item.id;
                    const isDropTarget = dragOverItemId === item.id && !isBeingDragged;

                    return (
                      <div
                        key={item.id}
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          setDraggedItem({ source: 'page', pageId: page.id, item });
                        }}
                        onDragEnd={() => {
                          setDraggedItem(null);
                          setDragOverItemId(null);
                          setDragOverPageId(null);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverItemId(item.id);
                        }}
                        onDragLeave={(e) => {
                          e.stopPropagation();
                          if (e.currentTarget === e.target) setDragOverItemId(null);
                        }}
                        onDrop={(e) => {
                          setDragOverItemId(null);
                          handleDropOnItem(e, page.id, item.id);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setPreviewImg(item);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          updateProject({ coverPhoto: item.data });
                          addToast('Set as project cover.', 'success');
                        }}
                        className={`relative group/item cursor-move w-full h-full overflow-hidden flex items-center justify-center transition-opacity duration-150
                          ${isBeingDragged ? 'opacity-40 grayscale' : 'opacity-100'}`}
                      >
                        {/* Insertion indicator: a glowing bar on the leading edge
                            shows the dragged photo will land here, pushing this
                            one to the right. */}
                        {isDropTarget && (
                          <div className="absolute inset-y-1 left-0 w-1.5 z-30 rounded-full bg-amber-400 shadow-[0_0_10px_2px_rgba(251,191,36,0.85)] pointer-events-none" />
                        )}
                        {isDropTarget && <div className="absolute inset-0 z-20 ring-2 ring-inset ring-amber-400/50 pointer-events-none" />}

                        {isDuplicate && (
                          <div className="absolute top-2 left-2 bg-neutral-900 text-amber-300 text-[10px] uppercase font-mono font-bold tracking-wider px-1.5 py-0.5 rounded shadow-sm z-10 pointer-events-none">
                            Dupe
                          </div>
                        )}
                        <img
                          src={item.data}
                          alt={item.filename || 'frame'}
                          className="w-full h-full object-cover object-center pointer-events-none"
                          style={{ transform: `scale(${imageScale / 100})` }}
                        />
                        {project.settings.showFileNames && item.filename && (
                          <div
                            className="absolute bottom-0 left-0 right-0 text-white text-center font-mono whitespace-normal break-words leading-tight max-h-[50%] overflow-hidden z-10 pointer-events-none"
                            style={{
                              backgroundColor: `rgba(0,0,0,${(project.settings.fileNameOpacity !== undefined ? project.settings.fileNameOpacity : 70) / 100})`,
                              fontSize: `${project.settings.fileNameSize || 12}px`,
                              padding: '6px 8px',
                            }}
                          >
                            {item.filename}
                          </div>
                        )}
                        {!isExporting && (
                          <button onClick={() => removePageItem(page.id, item.id)} className="absolute top-2 right-2 bg-black/60 text-white rounded-full p-1.5 opacity-100 sm:opacity-0 group-hover/item:opacity-100 transition-opacity hover:bg-red-500 no-print shadow-sm z-20" title="Remove photo">
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {imageItems.length === 0 && !isExporting && (
                    <div
                      className={`col-span-full h-full min-h-[360px] border-4 border-dashed flex flex-col items-center justify-center rounded-xl m-4 transition-colors pointer-events-none ${
                        draggedItem ? 'border-amber-400 text-amber-500 bg-amber-400/10' : 'border-neutral-300 dark:border-neutral-600 text-neutral-400 dark:text-neutral-500 bg-white/5'
                      }`}
                    >
                      <UploadCloud size={48} className="mb-4 opacity-60" />
                      <p className="font-medium">{draggedItem ? 'Drop to place here' : 'Drag photos here'}</p>
                      {!draggedItem && <p className="text-sm opacity-70">or use Auto-fill</p>}
                    </div>
                  )}
                </div>
              </div>

              {isOverCapacity && !isExporting && (
                <div className="w-full text-right mt-1 no-print">
                  <span className="bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 text-xs px-2 py-1 rounded shadow-sm font-mono font-medium uppercase tracking-wider">Sheet full</span>
                </div>
              )}
            </div>
          );
        })}

        {!isExporting && (
          <button
            onClick={addPage}
            className={`w-full py-6 border-2 border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 rounded-2xl hover:border-amber-400 hover:text-amber-600 dark:hover:text-amber-400 transition-all flex items-center justify-center gap-2 font-semibold no-print mb-12 bg-white dark:bg-neutral-900 shadow-sm ${maxWidthClass}`}
          >
            <Plus size={20} /> Add page
          </button>
        )}
      </div>

      {/* Export modal */}
      <Modal isOpen={isExportModalOpen} onClose={() => !isExporting && setIsExportModalOpen(false)} title="Export as PDF">
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              Image quality <span className="font-mono tabular-nums text-amber-600 dark:text-amber-400">{exportQuality}%</span>
            </label>
            <input type="range" min="10" max="100" step="5" value={exportQuality} onChange={(e) => setExportQuality(parseInt(e.target.value))} className="w-full accent-amber-500" disabled={isExporting} />
            <div className="flex justify-between text-xs text-neutral-500 mt-1">
              <span>Smaller file</span>
              <span>Sharper images</span>
            </div>
          </div>
          <div className="bg-neutral-50 dark:bg-neutral-800 p-4 rounded-xl border border-neutral-200 dark:border-neutral-700">
            <h4 className="text-xs font-mono uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-3">Summary</h4>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="text-neutral-600 dark:text-neutral-400">Pages with photos</span>
              <span className="font-mono tabular-nums font-medium text-neutral-900 dark:text-white">{nonEmptyPages}</span>
            </div>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="text-neutral-600 dark:text-neutral-400">Total frames</span>
              <span className="font-mono tabular-nums font-medium text-neutral-900 dark:text-white">{totalImages}</span>
            </div>
            <div className="flex justify-between text-sm font-semibold pt-2.5 border-t border-neutral-200 dark:border-neutral-700 mt-2.5">
              <span className="text-neutral-800 dark:text-neutral-200">Est. file size</span>
              <span className="font-mono tabular-nums text-amber-600 dark:text-amber-400">~{estimatedSizeMB} MB</span>
            </div>
          </div>
          <button onClick={handleExportPDF} disabled={isExporting || nonEmptyPages === 0} className="w-full bg-amber-500 text-neutral-950 rounded-lg py-3 font-semibold hover:bg-amber-400 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2">
            {isExporting ? (
              <>
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-neutral-950 border-t-transparent"></span> Building…
              </>
            ) : (
              <>
                <FileDown size={20} /> Download PDF
              </>
            )}
          </button>
          {nonEmptyPages === 0 && <p className="text-xs text-center text-neutral-500">Add a photo to a page before exporting.</p>}
        </div>
      </Modal>

      {/* Settings modal */}
      <Modal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} title="Grid settings">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Orientation</label>
              <select value={project.settings.orientation || 'portrait'} onChange={(e) => updateProject({ settings: { ...project.settings, orientation: e.target.value } })} className="w-full border border-neutral-300 dark:border-neutral-600 rounded-lg p-2 focus:ring-2 focus:ring-amber-500 outline-none bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white">
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Sheet color</label>
              <input type="color" value={project.settings.bgColor || '#000000'} onChange={(e) => updateProject({ settings: { ...project.settings, bgColor: e.target.value } })} className="w-full h-[42px] rounded-lg cursor-pointer bg-white dark:bg-neutral-700 p-1 border border-neutral-300 dark:border-neutral-600" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Columns</label>
            <input type="number" min="1" max="10" value={project.settings.columns} onChange={(e) => updateProject({ settings: { ...project.settings, columns: parseInt(e.target.value) || 1 } })} className="w-full border border-neutral-300 dark:border-neutral-600 rounded-lg p-2 focus:ring-2 focus:ring-amber-500 outline-none bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white font-mono" />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">Rows per sheet <span className="text-neutral-400 font-normal">— sets auto-fill capacity</span></label>
            <input type="number" min="1" max="15" value={project.settings.rows} onChange={(e) => updateProject({ settings: { ...project.settings, rows: parseInt(e.target.value) || 1 } })} className="w-full border border-neutral-300 dark:border-neutral-600 rounded-lg p-2 focus:ring-2 focus:ring-amber-500 outline-none bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white font-mono" />
          </div>
          <div className="pt-4 border-t border-neutral-100 dark:border-neutral-700">
            <button onClick={() => setIsSettingsOpen(false)} className="w-full bg-neutral-900 dark:bg-amber-500 dark:text-neutral-950 text-white rounded-lg py-2 font-medium hover:bg-black dark:hover:bg-amber-400 transition-colors">
              Done
            </button>
          </div>
        </div>
      </Modal>

      {/* Clear all confirm */}
      <Modal isOpen={isClearOpen} onClose={() => setIsClearOpen(false)} title="Clear all pages?">
        <div className="space-y-4">
          <p className="text-neutral-700 dark:text-neutral-300">
            This removes every photo from all {project.pages.length} {project.pages.length === 1 ? 'page' : 'pages'}. The pages and your staging photos stay put.
          </p>
          <div className="flex gap-3">
            <button onClick={() => setIsClearOpen(false)} className="flex-1 bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-white rounded-lg py-3 font-medium hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors">Cancel</button>
            <button onClick={clearAllPages} className="flex-1 bg-red-600 text-white rounded-lg py-3 font-medium hover:bg-red-700 transition-colors">Remove all photos</button>
          </div>
        </div>
      </Modal>

      {/* Page title modal */}
      <Modal isOpen={pageTitleModal.isOpen} onClose={() => setPageTitleModal({ isOpen: false, pageId: null, text: '' })} title="Add page title">
        <div className="space-y-4">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">A title block spans the full width at the top of the sheet, pushing frames down to keep the layout aligned.</p>
          <input type="text" placeholder="e.g., Scene 1 — Exterior" value={pageTitleModal.text} onChange={(e) => setPageTitleModal({ ...pageTitleModal, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && submitPageTitle()} autoFocus className="w-full border border-neutral-300 dark:border-neutral-600 rounded-lg p-3 text-lg focus:ring-2 focus:ring-amber-500 outline-none bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white" />
          <button onClick={submitPageTitle} className="w-full bg-amber-500 text-neutral-950 rounded-lg py-3 font-semibold hover:bg-amber-400 transition-colors shadow-sm">Insert title block</button>
        </div>
      </Modal>
    </div>
  );
};

// =============================================================================
// Root
// =============================================================================

const ContactSheetApp = () => {
  const [projects, setProjects] = useState<any[]>([]);
  const [activeProject, setActiveProject] = useState<any>(null);
  const [view, setView] = useState('dashboard');
  const [toast, setToast] = useState<any>(null);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [previewImg, setPreviewImg] = useState<any>(null);
  const [isDark, setIsDark] = useState(true);

  const [newProjectModal, setNewProjectModal] = useState<any>({ isOpen: false, name: '' });
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<any>({ isOpen: false, projectId: null });

  useEffect(() => {
    const init = async () => {
      const data = await loadProjectsFromDB();
      setProjects(data);
    };
    init();

    let startDark = true;
    try {
      const saved = localStorage.getItem('cs-theme');
      if (saved) startDark = saved === 'dark';
    } catch (e) {
      /* ignore */
    }
    setIsDark(startDark);
    document.documentElement.classList.toggle('dark', startDark);
  }, []);

  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle('dark', next);
      try {
        localStorage.setItem('cs-theme', next ? 'dark' : 'light');
      } catch (e) {
        /* ignore */
      }
      return next;
    });
  };

  const showToast = (message: string, type = 'info') => setToast({ message, type });

  const confirmCreateProject = async () => {
    const finalName = newProjectModal.name.trim() || 'Untitled Project';
    const newProject = {
      id: generateId(),
      name: finalName,
      created: Date.now(),
      lastModified: Date.now(),
      settings: { columns: 4, rows: 6, orientation: 'portrait', imageScale: 95, bgColor: '#0a0a0a', showFileNames: false, fileNameOpacity: 70, fileNameSize: 12 },
      staging: [],
      pages: [{ id: generateId(), items: [] }],
    };
    setProjects([newProject, ...projects]);
    setActiveProject(newProject);
    setView('editor');
    setNewProjectModal({ isOpen: false, name: '' });
    await saveProjectToDB(newProject);
  };

  const confirmDeleteProject = async () => {
    const id = deleteConfirmModal.projectId;
    await deleteProjectFromDB(id);
    setProjects(projects.filter((p) => p.id !== id));
    if (activeProject?.id === id) {
      setActiveProject(null);
      setView('dashboard');
    }
    setDeleteConfirmModal({ isOpen: false, projectId: null });
    showToast('Project deleted.', 'success');
  };

  const updateActiveProject = async (updates: any) => {
    const updatedProject = { ...activeProject, ...updates, lastModified: Date.now() };
    setActiveProject(updatedProject);
    setProjects(projects.map((p) => (p.id === updatedProject.id ? updatedProject : p)));
    await saveProjectToDB(updatedProject);
  };

  return (
    <div className="h-screen w-full font-sans text-neutral-900 dark:text-neutral-100 bg-neutral-50 dark:bg-neutral-950 flex overflow-hidden transition-colors">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {view === 'dashboard' ? (
        <div className="w-full h-full overflow-y-auto">
          <DashboardView
            projects={projects}
            isDark={isDark}
            onToggleTheme={toggleTheme}
            onTriggerNewProject={() => setNewProjectModal({ isOpen: true, name: '' })}
            onOpenProject={(p: any) => {
              setActiveProject(p);
              setView('editor');
            }}
            onTriggerDeleteProject={(id: string) => setDeleteConfirmModal({ isOpen: true, projectId: id })}
          />
        </div>
      ) : (
        <div className="flex w-full h-full">
          <div className="w-16 bg-neutral-900 dark:bg-black flex flex-col items-center py-4 gap-4 no-print border-r border-neutral-800 transition-colors z-[40]">
            <button onClick={() => setView('dashboard')} className="text-neutral-400 hover:text-amber-400 p-3 rounded-xl hover:bg-neutral-800 transition-colors" title="Back to dashboard">
              <LayoutGrid size={24} />
            </button>
          </div>

          <EditorSidebar project={activeProject} updateProject={updateActiveProject} draggedItem={draggedItem} setDraggedItem={setDraggedItem} addToast={showToast} />
          <EditorMain project={activeProject} updateProject={updateActiveProject} draggedItem={draggedItem} setDraggedItem={setDraggedItem} addToast={showToast} setPreviewImg={setPreviewImg} isDark={isDark} onToggleTheme={toggleTheme} />
        </div>
      )}

      <Modal isOpen={newProjectModal.isOpen} onClose={() => setNewProjectModal({ isOpen: false, name: '' })} title="New project">
        <div className="space-y-4">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">Name this contact sheet</label>
          <input type="text" placeholder="e.g., Summer Wedding Selects" value={newProjectModal.name} onChange={(e) => setNewProjectModal({ ...newProjectModal, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && confirmCreateProject()} autoFocus className="w-full border border-neutral-300 dark:border-neutral-600 rounded-lg p-3 text-lg focus:ring-2 focus:ring-amber-500 outline-none bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white" />
          <button onClick={confirmCreateProject} className="w-full bg-amber-500 text-neutral-950 rounded-lg py-3 font-semibold hover:bg-amber-400 transition-colors shadow-sm">Create project</button>
        </div>
      </Modal>

      <Modal isOpen={deleteConfirmModal.isOpen} onClose={() => setDeleteConfirmModal({ isOpen: false, projectId: null })} title="Delete project?">
        <div className="space-y-4">
          <p className="text-neutral-700 dark:text-neutral-300">This permanently removes the project and all its layouts. This can’t be undone.</p>
          <div className="flex gap-3 mt-4">
            <button onClick={() => setDeleteConfirmModal({ isOpen: false, projectId: null })} className="flex-1 bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-white rounded-lg py-3 font-medium hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors">Cancel</button>
            <button onClick={confirmDeleteProject} className="flex-1 bg-red-600 text-white rounded-lg py-3 font-medium hover:bg-red-700 transition-colors">Delete</button>
          </div>
        </div>
      </Modal>

      {previewImg && <Lightbox img={previewImg} onClose={() => setPreviewImg(null)} />}
    </div>
  );
};

export default ContactSheetApp;
