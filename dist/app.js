(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const ARTBOARD_BASE_HEIGHT = 675;
  const DB_NAME = "spetlyscroll-db";
  const DB_VERSION = 2;
  const PROJECT_STORE = "projects";
  const MEDIA_STORE = "media";
  const SNAP_THRESHOLD = 8;
  const RATIO_SIZES = {
    "4:5": { w: 540, h: 675, exportW: 1080, exportH: 1350 },
    "1:1": { w: 675, h: 675, exportW: 1080, exportH: 1080 },
    "9:16": { w: 380, h: 675, exportW: 1080, exportH: 1920 },
  };

  const state = {
    projectId: null,
    updatedAt: null,
    title: "Untitled carousel",
    slides: 3,
    ratio: "4:5",
    background: "#f4f1e8",
    slideBackgrounds: [],
    backgroundStart: 0,
    backgroundSpan: "all",
    zoom: 55,
    layers: [],
    media: [],
    selectedId: null,
    history: [],
    future: [],
    previewIndex: 0,
    activeTemplate: null,
    templatePhotoCount: 3,
    templateDefaultsVersion: 2,
    mediaStorageVersion: 1,
    cropModeId: null,
    frameDrawMode: false,
  };

  let drag = null;
  let saveTimer = null;
  let toastTimer = null;
  let persistEnabled = true;
  let databasePromise = null;
  let mediaDirty = false;
  let saveChain = Promise.resolve();
  const imageCache = new Map();

  const artboard = $("#artboard");
  const rightPanel = $(".right-panel");

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const isVisualLayer = (layer) => layer && (layer.type === "image" || layer.type === "video");
  const mediaKind = (item) => item?.type === "video" ? "video" : "image";

  function runtimeMediaItem(item) {
    if (!item) return item;
    const type = item.type || (item.mime?.startsWith("video/") ? "video" : "image");
    if (item.blob instanceof Blob) return { ...item, type, src:URL.createObjectURL(item.blob) };
    return { ...item, type };
  }

  function projectData() {
    return {
      projectId: state.projectId,
      updatedAt: state.updatedAt,
      title: state.title,
      slides: state.slides,
      ratio: state.ratio,
      background: state.background,
      slideBackgrounds: state.slideBackgrounds,
      backgroundStart: state.backgroundStart,
      backgroundSpan: state.backgroundSpan,
      layers: state.layers,
      media: state.media,
      activeTemplate: state.activeTemplate,
      templatePhotoCount: state.templatePhotoCount,
      templateDefaultsVersion: state.templateDefaultsVersion,
      mediaStorageVersion: state.mediaStorageVersion,
    };
  }

  function snapshot() {
    const data = projectData();
    return {
      ...data,
      slideBackgrounds:[...data.slideBackgrounds],
      layers:data.layers.map((layer) => ({...layer})),
      media:data.media.map((item) => ({...item})),
    };
  }

  function pushHistory() {
    state.history.push(snapshot());
    if (state.history.length > 40) state.history.shift();
    state.future = [];
    updateHistoryButtons();
  }

  function restore(data) {
    Object.assign(state, data, {
      slideBackgrounds:[...(data.slideBackgrounds || [])],
      layers:(data.layers || []).map((layer) => ({...layer})),
      media:(data.media || []).map((item) => ({...item})),
      selectedId:null,
    });
    mediaDirty = true;
    syncAll();
    scheduleSave();
  }

  function undo() {
    if (!state.history.length) return;
    state.future.push(snapshot());
    restore(state.history.pop());
    updateHistoryButtons();
  }

  function redo() {
    if (!state.future.length) return;
    state.history.push(snapshot());
    restore(state.future.pop());
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    $("#undoButton").disabled = !state.history.length;
    $("#redoButton").disabled = !state.future.length;
  }

  function scheduleSave() {
    $("#saveStatus").textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProjectNow, 500);
  }

  function projectIndex() {
    try {
      const index = JSON.parse(localStorage.getItem("seam-project-index") || "[]");
      return Array.isArray(index) ? index : [];
    } catch { return []; }
  }

  function migrateTemplatePhotoDefaults() {
    if ((state.templateDefaultsVersion || 0) >= 2) return false;
    const slots = state.layers.filter((layer) => isVisualLayer(layer) && layer.templateSlot).sort((a,b) => a.z - b.z);
    slots.forEach((layer) => { layer.radius = 0; layer.fit = "cover"; });
    const { w, h } = RATIO_SIZES[state.ratio] || RATIO_SIZES["4:5"];
    if (state.activeTemplate === "seasonal-edit" && slots.length >= 2) {
      Object.assign(slots[0], {x:0,y:0,w,h:h/2});
      Object.assign(slots[1], {x:0,y:h/2,w,h:h/2});
    } else if (state.activeTemplate === "four-frames" && slots.length >= 4) {
      [[0,0],[w/2,0],[0,h/2],[w/2,h/2]].forEach(([x,y], index) => Object.assign(slots[index], {x,y,w:w/2,h:h/2}));
    } else if (state.activeTemplate === "duo" && slots.length >= 2) {
      Object.assign(slots[0], {x:0,y:0,w,h});
      Object.assign(slots[1], {x:w,y:0,w,h});
    }
    state.templateDefaultsVersion = 2;
    return true;
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath:"projectId" });
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const store = db.createObjectStore(MEDIA_STORE, { keyPath:["projectId","id"] });
          store.createIndex("projectId", "projectId", { unique:false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  }

  async function idbRequest(storeName, mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  const getProjectRecord = (id) => id ? idbRequest(PROJECT_STORE, "readonly", (store) => store.get(id)) : Promise.resolve(null);
  const getProjectMedia = (id) => id ? idbRequest(MEDIA_STORE, "readonly", (store) => store.index("projectId").getAll(id)) : Promise.resolve([]);

  function hydrateProject(record, storedMedia = []) {
    if (!record) return null;
    const media = (storedMedia.length ? storedMedia : (record.media || [])).map(({projectId, ...item}) => runtimeMediaItem(item));
    const mediaById = new Map(media.map((item) => [item.id, item]));
    const mediaBySrc = new Map(media.map((item) => [item.src, item]));
    const layers = (record.layers || []).map((layer) => {
      const item = layer.mediaId ? mediaById.get(layer.mediaId) : mediaBySrc.get(layer.src);
      return item ? {...layer, mediaId:item.id, src:item.src} : {...layer};
    });
    return {...record, layers, media};
  }

  async function getProject(id) {
    const record = await getProjectRecord(id);
    return hydrateProject(record, await getProjectMedia(id));
  }

  async function getAllProjects() {
    const records = await idbRequest(PROJECT_STORE, "readonly", (store) => store.getAll());
    return Promise.all(records.map(async (record) => hydrateProject(record, await getProjectMedia(record.projectId))));
  }

  function prepareProjectRecord(project) {
    const mediaBySrc = new Map((project.media || []).map((item) => [item.src, item.id]));
    const mediaIds = new Set((project.media || []).map((item) => item.id));
    const layers = (project.layers || []).map((layer) => {
      const mediaId = mediaIds.has(layer.mediaId) ? layer.mediaId : mediaBySrc.get(layer.src);
      if (!mediaId) return {...layer};
      const copy = {...layer, mediaId};
      delete copy.src;
      return copy;
    });
    const record = {...project, layers, mediaStorageVersion:1};
    delete record.media;
    return record;
  }

  async function replaceProjectMedia(projectId, media) {
    const existingKeys = await idbRequest(MEDIA_STORE, "readonly", (store) => store.index("projectId").getAllKeys(projectId));
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(MEDIA_STORE, "readwrite");
      const store = transaction.objectStore(MEDIA_STORE);
      existingKeys.forEach((key) => store.delete(key));
      (media || []).forEach((item) => {
        const stored = {projectId, ...item};
        if (stored.blob instanceof Blob) delete stored.src;
        store.put(stored);
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function putProject(project, {writeMedia = true} = {}) {
    await idbRequest(PROJECT_STORE, "readwrite", (store) => store.put(prepareProjectRecord(project)));
    if (writeMedia) await replaceProjectMedia(project.projectId, project.media || []);
  }

  async function removeProject(id) {
    await idbRequest(PROJECT_STORE, "readwrite", (store) => store.delete(id));
    await replaceProjectMedia(id, []);
  }

  function updateProjectIndex(project) {
    const metadata = {
      id:project.projectId, title:project.title || "Untitled graphic", updatedAt:project.updatedAt,
      slides:project.slides, ratio:project.ratio, background:project.background,
    };
    const index = projectIndex().filter((entry) => entry.id !== project.projectId);
    index.unshift(metadata);
    localStorage.setItem("seam-project-index", JSON.stringify(index));
  }

  function saveProjectNow() {
    if (!persistEnabled || !state.projectId) return Promise.resolve();
    clearTimeout(saveTimer);
    state.updatedAt = Date.now();
    const project = snapshot();
    const writeMedia = mediaDirty || !project.mediaStorageVersion;
    mediaDirty = false;
    project.mediaStorageVersion = 1;
    saveChain = saveChain.then(async () => {
      await putProject(project, {writeMedia});
      localStorage.setItem("seam-current-project", project.projectId);
      updateProjectIndex(project);
      localStorage.removeItem(`seam-project:${project.projectId}`);
      localStorage.removeItem("seam-project");
      if (state.projectId === project.projectId) $("#saveStatus").textContent = "Saved locally";
    }).catch((error) => {
      if (writeMedia) mediaDirty = true;
      console.error("Project save failed", error);
      $("#saveStatus").textContent = "Save failed — retrying on next change";
    });
    return saveChain;
  }

  async function loadSaved() {
    let currentId = localStorage.getItem("seam-current-project");
    let data = await getProject(currentId);
    let legacyKey = currentId ? `seam-project:${currentId}` : "seam-project";
    let legacy = localStorage.getItem(legacyKey) || localStorage.getItem("seam-project");
    if (!data && !legacy) {
      currentId = projectIndex()[0]?.id || null;
      data = await getProject(currentId);
      legacyKey = `seam-project:${currentId}`;
      legacy = currentId ? localStorage.getItem(legacyKey) : null;
    }
    if (!data && !legacy) return false;
    try {
      if (!data) data = JSON.parse(legacy);
      if (data && Array.isArray(data.layers)) {
        Object.assign(state, data);
        state.projectId ||= currentId || uid();
        state.updatedAt ||= Date.now();
        if (!Array.isArray(state.slideBackgrounds)) state.slideBackgrounds = [];
        if (!Array.isArray(state.media)) state.media = [];
        mediaDirty = !data.mediaStorageVersion;
        state.mediaStorageVersion = 1;
        migrateTemplatePhotoDefaults();
        if (legacy) {
          await putProject(projectData());
          mediaDirty = false;
          updateProjectIndex(projectData());
          localStorage.removeItem(legacyKey);
          localStorage.removeItem("seam-project");
        }
        return true;
      }
    } catch (error) { console.error("Project load failed", error); }
    return false;
  }

  function ratioInfo() {
    return RATIO_SIZES[state.ratio];
  }

  function updateArtboardGeometry() {
    const { w, h } = ratioInfo();
    state.slideBackgrounds = Array.from({length:state.slides}, (_, index) => state.slideBackgrounds?.[index] || null);
    state.backgroundStart = Math.max(0, Math.min(state.slides - 1, state.backgroundStart || 0));
    artboard.style.setProperty("--slide-w", `${w}px`);
    artboard.style.setProperty("--artboard-w", `${w * state.slides}px`);
    artboard.style.setProperty("--artboard-h", `${h}px`);
    artboard.style.width = `${w * state.slides}px`;
    artboard.style.height = `${h}px`;
    $("#slideCount").textContent = state.slides;
    $("#templatePhotoCount").classList.toggle("hidden", state.activeTemplate !== "quiet-triptych");
    $("#templatePhotoCountSelect").value = String(state.templatePhotoCount || 3);
    $$("[data-ratio]").forEach((button) => button.classList.toggle("active", button.dataset.ratio === state.ratio));
    syncBackgroundControls();
    updateZoom();
  }

  function updateZoom() {
    const scale = state.zoom / 100;
    artboard.style.transform = `scale(${scale})`;
    const { w, h } = ratioInfo();
    const wrap = $("#canvasWrap");
    wrap.style.width = `${w * state.slides * scale + 140}px`;
    wrap.style.height = `${h * scale + 130}px`;
    $("#zoomRange").value = state.zoom;
    $("#zoomValue").textContent = `${state.zoom}%`;
  }

  function fitCanvas() {
    const scroller = $("#canvasScroller");
    const { w, h } = ratioInfo();
    const availableW = Math.max(240, scroller.clientWidth - 90);
    const availableH = Math.max(240, scroller.clientHeight - 90);
    state.zoom = Math.max(10, Math.min(100, Math.floor(Math.min(availableW / (w * state.slides), availableH / h) * 100)));
    updateZoom();
  }

  function renderLayers() {
    artboard.innerHTML = "";
    artboard.style.background = state.background;
    const { w, h } = ratioInfo();
    state.slideBackgrounds.forEach((color, index) => {
      if (!color) return;
      const background = document.createElement("div");
      background.className = "canvas-background-slide";
      background.dataset.slide = index;
      Object.assign(background.style, { left:`${index * w}px`, width:`${w}px`, height:`${h}px`, background:color });
      artboard.appendChild(background);
    });
    if (!state.layers.length) {
      const empty = document.createElement("div");
      empty.className = "canvas-empty";
      empty.innerHTML = "<span>Your story starts here.</span><small>Draw a photo frame, upload media, or choose a layout.</small>";
      artboard.appendChild(empty);
    }

    [...state.layers].filter((layer) => !layer.hidden).sort((a, b) => a.z - b.z).forEach((layer) => {
      const element = document.createElement("div");
      element.className = `canvas-layer ${layer.type}-layer${layer.templateSlot ? " template-slot" : ""}${layer.userFrame ? " user-frame" : ""}${layer.id === state.selectedId ? " selected" : ""}${layer.id === state.cropModeId ? " crop-mode" : ""}${layer.locked ? " locked" : ""}`;
      element.dataset.id = layer.id;
      Object.assign(element.style, {
        left: `${layer.x}px`,
        top: `${layer.y}px`,
        width: `${layer.w}px`,
        height: `${layer.h}px`,
        zIndex: layer.z,
        opacity: layer.opacity ?? 1,
        transform: `rotate(${layer.rotation || 0}deg)`,
        "--layer-rotation": `${layer.rotation || 0}deg`,
        borderRadius: `${layer.radius || 0}px`,
      });

      if (isVisualLayer(layer)) {
        const clip = document.createElement("div");
        clip.className = "image-clip";
        const mediaElement = document.createElement(layer.type === "video" ? "video" : "img");
        mediaElement.src = layer.src;
        if (layer.type === "video") {
          mediaElement.muted = true;
          mediaElement.loop = true;
          mediaElement.autoplay = true;
          mediaElement.playsInline = true;
          mediaElement.preload = "metadata";
        } else {
          mediaElement.alt = "";
          mediaElement.draggable = false;
        }
        mediaElement.style.objectFit = layer.fit || "cover";
        mediaElement.style.borderRadius = `${layer.radius || 0}px`;
        mediaElement.style.filter = layer.filter || "none";
        mediaElement.style.objectPosition = `${layer.focusX ?? 50}% ${layer.focusY ?? 50}%`;
        mediaElement.style.transformOrigin = `${layer.focusX ?? 50}% ${layer.focusY ?? 50}%`;
        mediaElement.style.transform = `scale(${layer.imageScale || 1})`;
        clip.appendChild(mediaElement);
        element.appendChild(clip);
      } else {
        element.textContent = layer.text;
        Object.assign(element.style, {
          fontFamily: layer.fontFamily,
          fontSize: `${layer.fontSize}px`,
          fontWeight: layer.fontWeight || 400,
          color: layer.color,
          textAlign: layer.align || "left",
          letterSpacing: layer.letterSpacing || "normal",
          textTransform: layer.textTransform || "none",
        });
      }

      const handle = document.createElement("span");
      handle.className = "resize-handle";
      handle.dataset.resize = "true";
      element.appendChild(handle);
      artboard.appendChild(element);
    });

    syncProperties();
    renderLayerList();
    syncFrameDrawMode();
  }

  function selectLayer(id) {
    state.selectedId = id;
    if (state.cropModeId && state.cropModeId !== id) state.cropModeId = null;
    renderLayers();
  }

  function selectedLayer() {
    return state.layers.find((layer) => layer.id === state.selectedId);
  }

  function renderLayerList() {
    const list = $("#layersList");
    $("#layerCount").textContent = state.layers.length;
    list.innerHTML = "";
    const ordered = [...state.layers].sort((a, b) => b.z - a.z);
    if (!ordered.length) {
      list.innerHTML = '<div class="layers-empty">Your layers will appear here.</div>';
      return;
    }
    ordered.forEach((layer, index) => {
      const row = document.createElement("div");
      row.className = `layer-row${layer.id === state.selectedId ? " selected" : ""}`;
      row.dataset.id = layer.id;
      row.draggable = true;
      const visualCount = ordered.filter(isVisualLayer).length;
      const visualIndex = visualCount - ordered.slice(0, index).filter(isVisualLayer).length;
      const label = layer.type === "video" ? `Video ${visualIndex}` : layer.type === "image" ? `Photo ${visualIndex}` : (layer.text || "Text").replace(/\n/g, " ");
      const visualThumb = layer.type === "video" ? (layer.poster || "") : layer.src;
      row.innerHTML = `
        <span class="layer-drag" title="Drag to reorder">⠿</span>
        <span class="layer-thumb">${isVisualLayer(layer) ? `<img src="${visualThumb}" alt="" />${layer.type === "video" ? "<i>▶</i>" : ""}` : "Aa"}</span>
        <span class="layer-meta"><b>${escapeHtml(label)}</b><small>${layer.type === "video" ? "Video" : layer.type === "image" ? "Photo" : "Text"}${layer.locked ? " · Locked" : ""}</small></span>
        <button class="layer-toggle visibility-toggle${layer.hidden ? "" : " active"}" aria-label="${layer.hidden ? "Show" : "Hide"} layer"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button>
        <button class="layer-toggle lock-toggle${layer.locked ? " active" : ""}" aria-label="${layer.locked ? "Unlock" : "Lock"} layer"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></button>`;
      row.addEventListener("click", () => selectLayer(layer.id));
      $(".visibility-toggle", row).addEventListener("click", (event) => {
        event.stopPropagation();
        pushHistory();
        layer.hidden = !layer.hidden;
        renderLayers();
        scheduleSave();
      });
      $(".lock-toggle", row).addEventListener("click", (event) => {
        event.stopPropagation();
        pushHistory();
        layer.locked = !layer.locked;
        if (layer.locked && state.cropModeId === layer.id) state.cropModeId = null;
        renderLayers();
        scheduleSave();
      });
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-seam-layer", layer.id);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (event) => {
        if (![...event.dataTransfer.types].includes("application/x-seam-layer")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", (event) => {
        const sourceId = event.dataTransfer.getData("application/x-seam-layer");
        if (!sourceId || sourceId === layer.id) return;
        event.preventDefault();
        event.stopPropagation();
        pushHistory();
        const stack = [...state.layers].sort((a, b) => b.z - a.z);
        const sourceIndex = stack.findIndex((item) => item.id === sourceId);
        const targetIndex = stack.findIndex((item) => item.id === layer.id);
        const [moved] = stack.splice(sourceIndex, 1);
        stack.splice(targetIndex, 0, moved);
        stack.forEach((item, stackIndex) => { item.z = stack.length - stackIndex; });
        renderLayers();
        scheduleSave();
      });
      list.appendChild(row);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[character]);
  }

  function projectPreviewMarkup(project) {
    const info = RATIO_SIZES[project.ratio] || RATIO_SIZES["4:5"];
    const firstBackground = project.slideBackgrounds?.[0] || project.background || "#f4f1e8";
    const layers = (project.layers || []).filter((layer) => !layer.hidden && layer.x < info.w && layer.x + layer.w > 0).sort((a,b) => a.z - b.z);
    const layerMarkup = layers.map((layer) => {
      const baseStyle = `left:${layer.x / info.w * 100}%;top:${layer.y / info.h * 100}%;width:${layer.w / info.w * 100}%;height:${layer.h / info.h * 100}%;z-index:${layer.z};opacity:${layer.opacity ?? 1};transform:rotate(${layer.rotation || 0}deg);border-radius:${Math.max(0,(layer.radius || 0) / info.w * 100)}%;`;
      if (isVisualLayer(layer)) {
        const media = (project.media || []).find((item) => item.id === layer.mediaId);
        const source = layer.type === "video" ? (layer.poster || media?.poster || "") : layer.src;
        return `<span class="project-mini-layer" style="${baseStyle}"><img src="${source}" alt="" style="object-position:${layer.focusX ?? 50}% ${layer.focusY ?? 50}%;transform:scale(${layer.imageScale || 1});filter:${layer.filter || "none"}" />${layer.type === "video" ? '<i class="project-video-badge">▶</i>' : ''}</span>`;
      }
      return `<span class="project-mini-layer project-mini-text" style="${baseStyle}font-family:${layer.fontFamily || "sans-serif"};font-size:${Math.max(4,Math.min(18,(layer.fontSize || 20) / 5))}px;font-weight:${layer.fontWeight || 400};color:${layer.color || "#171719"};text-align:${layer.align || "left"}">${escapeHtml(layer.text || "")}</span>`;
    }).join("");
    return `<div class="project-preview-page" style="aspect-ratio:${info.w}/${info.h};background:${firstBackground}">${layerMarkup}</div>`;
  }

  function formatProjectDate(timestamp) {
    if (!timestamp) return "Saved locally";
    return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(new Date(timestamp));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFilename(value, fallback = "spetlyscroll-project") {
    return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"") || fallback;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function exportProjectBackup(projectId = state.projectId) {
    if (projectId === state.projectId) await saveProjectNow();
    const project = await getProject(projectId);
    if (!project) return showToast("Project backup could not be created");
    const backupProject = snapshotProjectForBackup(project);
    for (const item of backupProject.media) {
      if (item.blob instanceof Blob) {
        item.src = await blobToDataUrl(item.blob);
        delete item.blob;
      }
    }
    const payload = { format:"spetlyscroll-project", version:2, exportedAt:Date.now(), project:backupProject };
    downloadBlob(new Blob([JSON.stringify(payload)], {type:"application/json"}), `${safeFilename(project.title)}.spetlyscroll`);
    showToast("Project backup downloaded");
  }

  function snapshotProjectForBackup(project) {
    return {
      ...project,
      slideBackgrounds:[...(project.slideBackgrounds || [])],
      layers:(project.layers || []).map((layer) => ({...layer})),
      media:(project.media || []).map((item) => ({...item})),
    };
  }

  async function importProjectBackup(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const imported = payload?.project || payload;
      if (!imported || !Array.isArray(imported.layers) || !Array.isArray(imported.media)) throw new Error("Invalid project");
      const project = structuredClone(imported);
      project.projectId = uid();
      project.title = `${project.title || "Imported graphic"} — imported`;
      project.updatedAt = Date.now();
      await putProject(project);
      updateProjectIndex(project);
      await renderProjectHome();
      showToast("Project imported");
    } catch (error) {
      console.error(error);
      showToast("This is not a valid Spetlyscroll project backup");
    } finally {
      $("#projectImportInput").value = "";
    }
  }

  async function duplicateProject(projectId) {
    const source = await getProject(projectId);
    if (!source) return;
    const copy = structuredClone(source);
    copy.projectId = uid();
    copy.title = `${source.title || "Untitled graphic"} — copy`;
    copy.updatedAt = Date.now();
    await putProject(copy);
    updateProjectIndex(copy);
    await renderProjectHome();
    showToast("Project duplicated");
  }

  async function deleteProjectFromHome(projectId) {
    const project = await getProject(projectId);
    if (!project || !confirm(`Delete “${project.title || "Untitled graphic"}”? This cannot be undone.`)) return;
    await removeProject(projectId);
    localStorage.removeItem(`seam-project:${projectId}`);
    localStorage.setItem("seam-project-index", JSON.stringify(projectIndex().filter((entry) => entry.id !== projectId)));
    if (localStorage.getItem("seam-current-project") === projectId) localStorage.removeItem("seam-current-project");
    await renderProjectHome();
    showToast("Project deleted");
  }

  async function renderProjectHome() {
    const grid = $("#projectGrid");
    const projects = (await getAllProjects()).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    $("#projectCount").textContent = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
    if (!projects.length) {
      grid.innerHTML = '<div class="project-empty"><div><b>No graphics yet</b><span>Create your first design with the button above.</span></div></div>';
      return;
    }
    grid.innerHTML = projects.map((project) => `
      <article class="project-card" data-project-id="${project.projectId}">
        <button class="project-open" aria-label="Open ${escapeHtml(project.title || "Untitled graphic")}">
          <span class="project-card-preview">${projectPreviewMarkup(project)}</span>
          <span class="project-card-meta">
            <span><b>${escapeHtml(project.title || "Untitled graphic")}</b><small>${project.slides} ${project.slides === 1 ? "slide" : "slides"} · ${project.ratio} · ${formatProjectDate(project.updatedAt)}</small></span>
            <span class="project-card-arrow"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></span>
          </span>
        </button>
        <div class="project-card-actions">
          <button data-project-action="duplicate">Duplicate</button>
          <button data-project-action="backup">Backup</button>
          <button class="danger-text" data-project-action="delete">Delete</button>
        </div>
      </article>`).join("");
    $$(".project-card", grid).forEach((card) => {
      const id = card.dataset.projectId;
      $(".project-open", card).addEventListener("click", () => openProject(id));
      $$("[data-project-action]", card).forEach((button) => button.addEventListener("click", () => {
        if (button.dataset.projectAction === "duplicate") duplicateProject(id);
        if (button.dataset.projectAction === "backup") exportProjectBackup(id);
        if (button.dataset.projectAction === "delete") deleteProjectFromHome(id);
      }));
    });
  }

  async function showHome() {
    if (state.projectId) await saveProjectNow();
    await renderProjectHome();
    $("#homeScreen").classList.remove("hidden");
    [$(".topbar"), $(".workspace")].forEach((element) => { element.inert = true; element.setAttribute("aria-hidden", "true"); });
  }

  function showEditor() {
    $("#homeScreen").classList.add("hidden");
    [$(".topbar"), $(".workspace")].forEach((element) => { element.inert = false; element.removeAttribute("aria-hidden"); });
    setTimeout(fitCanvas, 60);
  }

  async function openProject(projectId) {
    try {
      const data = await getProject(projectId);
      if (!data) return;
      Object.assign(state, data, {
        projectId:data.projectId || projectId,
        updatedAt:data.updatedAt || Date.now(),
        slideBackgrounds:Array.isArray(data.slideBackgrounds) ? data.slideBackgrounds : [],
        selectedId:null, history:[], future:[], previewIndex:0, cropModeId:null, frameDrawMode:false,
        backgroundStart:data.backgroundStart || 0, backgroundSpan:data.backgroundSpan || "all",
      });
      mediaDirty = !data.mediaStorageVersion;
      state.mediaStorageVersion = 1;
      const migrated = migrateTemplatePhotoDefaults();
      localStorage.setItem("seam-current-project", state.projectId);
      syncAll();
      showEditor();
      if (migrated) scheduleSave();
    } catch (error) { console.error(error); showToast("This project could not be opened"); }
  }

  function startNewProject() {
    clearTimeout(saveTimer);
    Object.assign(state, {
      projectId:uid(), updatedAt:Date.now(), title:"Untitled graphic", slides:1, ratio:"4:5",
      background:"#f4f1e8", slideBackgrounds:[], backgroundStart:0, backgroundSpan:"all", zoom:55,
      layers:[], media:[], selectedId:null, history:[], future:[], previewIndex:0,
      activeTemplate:"blank-single", templatePhotoCount:3, cropModeId:null, frameDrawMode:false,
      templateDefaultsVersion:2,
    });
    persistEnabled = true;
    mediaDirty = true;
    $$("[data-template-group]").forEach((button) => button.classList.toggle("active", button.dataset.templateGroup === "single"));
    $$(".template-card").forEach((card) => {
      card.classList.toggle("template-hidden", card.dataset.group !== "single");
      card.classList.toggle("selected", card.dataset.template === "blank-single");
    });
    switchPanel("layouts");
    syncAll();
    showEditor();
    saveProjectNow();
  }

  function addMediaLayer(item, placement = null) {
    pushHistory();
    const { w, h } = ratioInfo();
    const aspect = (item.w || 1200) / (item.h || 900);
    let width = Math.min(w * 1.35, 650);
    let height = width / aspect;
    if (height > h * .85) { height = h * .85; width = height * aspect; }
    const totalWidth = w * state.slides;
    const x = placement ? Math.max(0, Math.min(totalWidth - width, placement.x - width / 2)) : Math.max(24, (totalWidth - width) / 2);
    const y = placement ? Math.max(0, Math.min(h - height, placement.y - height / 2)) : (h - height) / 2;
    const layer = {
      id: uid(), type: mediaKind(item), src:item.src, mediaId:item.id || null, poster:item.poster || null,
      x, y,
      w: width, h: height, z: nextZ(), opacity: 1, radius: 0, fit: "cover", rotation: 0,
      imageScale:1, focusX:50, focusY:50, hidden:false, locked:false,
    };
    state.layers.push(layer);
    state.selectedId = layer.id;
    renderLayers();
    scheduleSave();
  }

  function addImage(src, naturalW = 1200, naturalH = 900, placement = null, mediaId = null) {
    addMediaLayer({id:mediaId, type:"image", src, w:naturalW, h:naturalH}, placement);
  }

  function addText(style = "display") {
    pushHistory();
    const { w, h } = ratioInfo();
    const presets = {
      display: { text: "Make it memorable", fontFamily: "'Instrument Serif', serif", fontSize: 92, fontWeight: 400, w: 520, h: 118, letterSpacing: "normal", textTransform: "none" },
      body: { text: "Add a little context to your story.", fontFamily: "'DM Sans', sans-serif", fontSize: 34, fontWeight: 500, w: 470, h: 95, letterSpacing: "normal", textTransform: "none" },
      label: { text: "A MOMENT TO KEEP", fontFamily: "'DM Sans', sans-serif", fontSize: 22, fontWeight: 700, w: 340, h: 48, letterSpacing: ".15em", textTransform: "uppercase" },
    };
    const preset = presets[style];
    const layer = { id: uid(), type: "text", x: Math.max(28, (w * state.slides - preset.w) / 2), y: h * .42, z: nextZ(), color: "#171719", align: "left", opacity: 1, rotation: 0, ...preset };
    state.layers.push(layer);
    state.selectedId = layer.id;
    renderLayers();
    scheduleSave();
  }

  function nextZ() {
    return state.layers.reduce((max, layer) => Math.max(max, layer.z), 0) + 1;
  }

  function deleteSelected() {
    if (!state.selectedId) return;
    if (selectedLayer()?.locked) { showToast("Unlock this layer before deleting it"); return; }
    pushHistory();
    state.layers = state.layers.filter((layer) => layer.id !== state.selectedId);
    state.selectedId = null;
    state.cropModeId = null;
    renderLayers();
    scheduleSave();
  }

  function duplicateSelected() {
    const layer = selectedLayer();
    if (!layer) return;
    if (layer.locked) { showToast("Unlock this layer before duplicating it"); return; }
    pushHistory();
    const duplicate = {...layer};
    duplicate.id = uid();
    duplicate.x += 20;
    duplicate.y += 20;
    duplicate.z = nextZ();
    duplicate.locked = false;
    duplicate.hidden = false;
    state.layers.push(duplicate);
    state.selectedId = duplicate.id;
    state.cropModeId = null;
    renderLayers();
    scheduleSave();
  }

  function syncProperties() {
    const layer = selectedLayer();
    $("#propertiesEmpty").classList.toggle("hidden", !!layer);
    $("#propertiesPanel").classList.toggle("hidden", !layer);
    rightPanel.classList.toggle("has-selection", !!layer);
    if (!layer) return;
    $("#layerType").textContent = layer.type === "video" ? "Video" : layer.type === "image" ? "Photo" : "Text";
    $("#imageProperties").classList.toggle("hidden", !isVisualLayer(layer));
    $("#textProperties").classList.toggle("hidden", layer.type !== "text");
    $("#geometryX").value = Math.round(layer.x * 10) / 10;
    $("#geometryY").value = Math.round(layer.y * 10) / 10;
    $("#geometryW").value = Math.round(layer.w * 10) / 10;
    $("#geometryH").value = Math.round(layer.h * 10) / 10;
    $("#geometryRotation").value = Math.round((layer.rotation || 0) * 10) / 10;
    $("#opacityRange").value = Math.round((layer.opacity ?? 1) * 100);
    $("#opacityValue").textContent = `${$("#opacityRange").value}%`;
    if (isVisualLayer(layer)) {
      $("#radiusRange").value = layer.radius || 0;
      $("#radiusValue").textContent = layer.radius || 0;
      $("#imageZoomRange").value = Math.round((layer.imageScale || 1) * 100);
      $("#imageZoomValue").textContent = `${$("#imageZoomRange").value}%`;
      $("#imageFocusXRange").value = layer.focusX ?? 50;
      $("#imageFocusXValue").textContent = `${$("#imageFocusXRange").value}%`;
      $("#imageFocusYRange").value = layer.focusY ?? 50;
      $("#imageFocusYValue").textContent = `${$("#imageFocusYRange").value}%`;
      $("#repositionImage").classList.toggle("active", state.cropModeId === layer.id);
      $("#repositionImage span").textContent = state.cropModeId === layer.id ? "Finish repositioning" : "Reposition on canvas";
      $$('[data-fit]').forEach((button) => button.classList.toggle("active", button.dataset.fit === (layer.fit || "cover")));
    } else {
      $("#textContent").value = layer.text;
      $("#fontFamily").value = layer.fontFamily;
      $("#fontPreview").style.fontFamily = layer.fontFamily;
      $("#fontPreview").textContent = (layer.text || "Make it memorable").replace(/\n/g," ").slice(0,42);
      $("#fontSizeRange").value = layer.fontSize;
      $("#fontSizeValue").textContent = layer.fontSize;
      $("#textColor").value = layer.color;
      $$("#textAlign button").forEach((button) => button.classList.toggle("active", button.dataset.align === layer.align));
    }
  }

  function updateLayerElement(layer) {
    const element = $(`.canvas-layer[data-id="${layer.id}"]`);
    if (!element) return renderLayers();
    Object.assign(element.style, {
      left:`${layer.x}px`, top:`${layer.y}px`, width:`${layer.w}px`, height:`${layer.h}px`,
      zIndex:layer.z, opacity:layer.opacity ?? 1, transform:`rotate(${layer.rotation || 0}deg)`,
      borderRadius:`${layer.radius || 0}px`,
    });
    if (isVisualLayer(layer)) {
      const mediaElement = $("img,video", element);
      if (mediaElement) {
        if (mediaElement.src !== layer.src) mediaElement.src = layer.src;
        mediaElement.style.objectFit = layer.fit || "cover";
        mediaElement.style.borderRadius = `${layer.radius || 0}px`;
        mediaElement.style.objectPosition = `${layer.focusX ?? 50}% ${layer.focusY ?? 50}%`;
        mediaElement.style.transformOrigin = `${layer.focusX ?? 50}% ${layer.focusY ?? 50}%`;
        mediaElement.style.transform = `scale(${layer.imageScale || 1})`;
        mediaElement.style.filter = layer.filter || "none";
      }
    } else {
      const textNode = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      if (textNode) textNode.nodeValue = layer.text;
      Object.assign(element.style, {
        fontFamily:layer.fontFamily, fontSize:`${layer.fontSize}px`, fontWeight:layer.fontWeight || 400,
        color:layer.color, textAlign:layer.align || "left", letterSpacing:layer.letterSpacing || "normal",
        textTransform:layer.textTransform || "none",
      });
    }
    syncProperties();
  }

  function mutateSelected(mutator, history = false, fullRender = false) {
    const layer = selectedLayer();
    if (!layer) return;
    if (layer.locked) { showToast("Unlock this layer to edit it"); syncProperties(); return; }
    if (history) pushHistory();
    mutator(layer);
    if (fullRender) renderLayers();
    else updateLayerElement(layer);
    scheduleSave();
  }

  function syncAll() {
    $("#projectTitle").value = state.title;
    updateArtboardGeometry();
    renderMedia();
    renderLayers();
  }

  function renderMedia() {
    const grid = $("#mediaGrid");
    grid.innerHTML = "";
    $("#mediaDragHint").classList.toggle("visible", state.media.length > 0);
    state.media.forEach((item) => {
      const wrapper = document.createElement("div");
      wrapper.className = "media-item";
      const button = document.createElement("button");
      button.className = `media-thumb${mediaKind(item) === "video" ? " video-media" : ""}`;
      button.draggable = true;
      button.title = "Drag into a frame or click to add";
      button.setAttribute("aria-label", `Add uploaded ${mediaKind(item)} to canvas`);
      button.innerHTML = `<img src="${item.poster || item.src}" alt="Uploaded ${mediaKind(item)}" />${mediaKind(item) === "video" ? `<span class="media-duration">${formatDuration(item.duration)}</span>` : ""}`;
      button.addEventListener("click", () => addMediaLayer(item));
      button.addEventListener("dragstart", (event) => {
        if (state.frameDrawMode) setFrameDrawMode(false, false);
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-seam-media", item.id);
        event.dataTransfer.setData("text/plain", item.id);
        button.classList.add("dragging");
      });
      button.addEventListener("dragend", () => {
        button.classList.remove("dragging");
        artboard.classList.remove("media-drop-target");
      });
      const remove = document.createElement("button");
      remove.className = "media-delete";
      remove.type = "button";
      remove.title = "Remove from Media";
      remove.setAttribute("aria-label", "Remove item from Media");
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        state.layers.forEach((layer) => { if (layer.mediaId === item.id) layer.mediaId = null; });
        state.media = state.media.filter((media) => media.id !== item.id);
        if (item.blob instanceof Blob && item.src?.startsWith("blob:")) URL.revokeObjectURL(item.src);
        mediaDirty = true;
        renderMedia();
        scheduleSave();
        showToast("Media removed · canvas copies stay in place");
      });
      wrapper.append(button, remove);
      grid.appendChild(wrapper);
    });
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "0:00";
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }

  function replaceMediaInLayer(layer, item) {
    if (!layer) return false;
    if (layer.locked) { showToast("Unlock this layer to replace its media"); return false; }
    pushHistory();
    layer.type = mediaKind(item);
    layer.src = item.src;
    layer.mediaId = item.id;
    layer.poster = item.poster || null;
    layer.fit = "cover";
    layer.imageScale = 1;
    layer.focusX = 50;
    layer.focusY = 50;
    state.selectedId = layer.id;
    state.cropModeId = null;
    renderLayers();
    scheduleSave();
    showToast(`${layer.type === "video" ? "Video" : "Photo"} placed in frame`);
    return true;
  }

  function isSupportedMediaFile(file) {
    return file.type.startsWith("image/") || file.type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(file.name || "");
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          resolve({ id:uid(), type:"image", src:reader.result, w:image.naturalWidth, h:image.naturalHeight, mime:file.type, name:file.name, size:file.size });
        };
        image.onerror = reject;
        image.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function readVideoFile(file) {
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.onerror = () => { URL.revokeObjectURL(src); reject(new Error(`Could not read ${file.name}`)); };
      video.onloadeddata = () => {
        try {
          const canvas = document.createElement("canvas");
          const thumbW = 480;
          const thumbH = Math.max(1, Math.round(thumbW * video.videoHeight / video.videoWidth));
          canvas.width = thumbW;
          canvas.height = thumbH;
          canvas.getContext("2d").drawImage(video, 0, 0, thumbW, thumbH);
          resolve({
            id:uid(), type:"video", src, blob:file, poster:canvas.toDataURL("image/jpeg", .82),
            w:video.videoWidth, h:video.videoHeight, duration:video.duration, mime:file.type || "video/mp4",
            name:file.name, size:file.size,
          });
        } catch (error) { URL.revokeObjectURL(src); reject(error); }
      };
      video.src = src;
    });
  }

  async function handleFiles(files, targetLayerId = null, placement = null, placeOnCanvas = false) {
    const mediaFiles = [...files].filter(isSupportedMediaFile);
    if (!mediaFiles.length) return showToast("Choose a photo or video file");
    let loadedCount = 0;
    for (let index = 0; index < mediaFiles.length; index++) {
      const file = mediaFiles[index];
      try {
        const item = file.type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(file.name || "")
          ? await readVideoFile(file)
          : await readImageFile(file);
        state.media.push(item);
        mediaDirty = true;
        renderMedia();
        const targetLayer = index === 0 && targetLayerId ? state.layers.find((layer) => layer.id === targetLayerId) : null;
        if (targetLayer) replaceMediaInLayer(targetLayer, item);
        else if (placeOnCanvas) {
          const offsetPlacement = placement ? { x:placement.x + index * 24, y:placement.y + index * 24 } : null;
          addMediaLayer(item, offsetPlacement);
        } else scheduleSave();
        loadedCount++;
      } catch (error) {
        console.error(error);
        showToast(`Could not add ${file.name}`);
      }
    }
    if (!targetLayerId && !placeOnCanvas && loadedCount) showToast(`${loadedCount} media ${loadedCount === 1 ? "item" : "items"} added to Media`);
  }

  function switchPanel(name) {
    $$(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
    $$(".tool-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${name}`));
    if (window.innerWidth <= 760) $(".left-panel").classList.add("open");
  }

  function backgroundColorForSlide(index) {
    return state.slideBackgrounds?.[index] || state.background;
  }

  function backgroundScopeRange() {
    if (state.backgroundSpan === "all") return { start:0, count:state.slides };
    const start = Math.max(0, Math.min(state.slides - 1, state.backgroundStart || 0));
    return { start, count:Math.min(Number(state.backgroundSpan) || 1, state.slides - start) };
  }

  function syncBackgroundControls() {
    const startSelect = $("#backgroundStart");
    if (!startSelect) return;
    const currentOptions = [...startSelect.options];
    if (currentOptions.length !== state.slides) {
      startSelect.innerHTML = Array.from({length:state.slides}, (_, index) => `<option value="${index}">Slide ${index + 1}</option>`).join("");
    }
    state.backgroundStart = Math.max(0, Math.min(state.slides - 1, state.backgroundStart || 0));
    startSelect.value = String(state.backgroundStart);
    startSelect.disabled = state.backgroundSpan === "all";
    $$("[data-bg-span]").forEach((button) => button.classList.toggle("active", button.dataset.bgSpan === String(state.backgroundSpan)));
    const range = backgroundScopeRange();
    $("#backgroundScopeStatus").textContent = state.backgroundSpan === "all"
      ? "Entire carousel"
      : range.count === 1
        ? `Slide ${range.start + 1}`
        : `Slides ${range.start + 1}–${range.start + range.count}`;
    const activeIndexes = new Set(Array.from({length:range.count}, (_, index) => range.start + index));
    $("#backgroundMap").innerHTML = Array.from({length:state.slides}, (_, index) =>
      `<i class="${activeIndexes.has(index) ? "in-scope" : ""}" style="background:${backgroundColorForSlide(index)}" title="Slide ${index + 1}"></i>`
    ).join("");
    const selectedColor = state.backgroundSpan === "all" ? state.background : backgroundColorForSlide(range.start);
    $("#customColor").value = selectedColor;
    $$("#colorGrid button").forEach((button) => button.classList.toggle("selected", button.dataset.color === selectedColor));
  }

  function setBackground(color) {
    pushHistory();
    const range = backgroundScopeRange();
    if (state.backgroundSpan === "all") {
      state.background = color;
      state.slideBackgrounds = Array(state.slides).fill(null);
    } else {
      for (let index = range.start; index < range.start + range.count; index++) state.slideBackgrounds[index] = color;
    }
    renderLayers();
    syncBackgroundControls();
    scheduleSave();
  }

  function clearProject(withHistory = true) {
    if (withHistory) pushHistory();
    state.layers = [];
    state.selectedId = null;
    renderLayers();
  }

  function applyTemplate(name) {
    pushHistory();
    state.activeTemplate = name;
    state.templatePhotoCount = name === "quiet-triptych" ? 3 : null;
    state.templateDefaultsVersion = 2;
    const singleTemplates = ["blank-single", "seasonal-edit", "split-focus", "four-frames", "scrapbook", "nine-mood", "portrait-notes", "quiet-triptych"];
    const carouselSlideCounts = {
      duo:2, "wedding-story":5, "garden-flow":6, "monochrome-vows":5, "minimal-frames":5, "collage-reel":6,
      "border-mosaic":6, "fullbleed-mosaic":6, "overlap-story":6, "family-tapestry":5, "coastal-echoes":6,
    };
    state.ratio = "4:5";
    state.slides = singleTemplates.includes(name) ? 1 : (carouselSlideCounts[name] || 3);
    const { w, h } = ratioInfo();
    state.layers = [];
    state.slideBackgrounds = [];
    state.backgroundStart = 0;
    state.backgroundSpan = "all";
    state.selectedId = null;
    const photo = (x, y, width, height, colors, options = {}) => ({
      id:uid(), type:"image", src:makePlaceholder(colors, width, height), x, y, w:width, h:height,
      z:options.z ?? 1, opacity:1, radius:0, fit:"cover", rotation:options.rotation ?? 0,
      filter:options.filter || "none", templateSlot:true, imageScale:1, focusX:50, focusY:50, hidden:false, locked:false,
    });
    const copy = (content, x, y, width, height, options = {}) => ({
      id:uid(), type:"text", text:content, x, y, w:width, h:height, z:options.z ?? 10,
      fontFamily:options.fontFamily || "'DM Sans', sans-serif", fontSize:options.fontSize ?? 24,
      fontWeight:options.fontWeight ?? 500, color:options.color || "#171719", align:options.align || "left",
      letterSpacing:options.letterSpacing || "normal", textTransform:options.textTransform || "none",
      opacity:1, rotation:options.rotation ?? 0,
    });

    if (name === "blank-single" || name === "blank-carousel") {
      state.background = "#f4f1e8";
    } else if (name === "seasonal-edit") {
      state.background = "#e9e5dc";
      state.layers.push(photo(0, 0, w, h/2, ["#cdd4d9", "#f1e8df"]));
      state.layers.push(photo(0, h/2, w, h/2, ["#9d7458", "#e7bd93"], {z:2}));
      state.layers.push(copy("THE\nSEASONS", 148, h*.41, 300, 130, {fontFamily:"'Instrument Serif', serif", fontSize:67, fontWeight:400, color:"#fffaf3", z:6}));
      state.layers.push(copy("NEW FASHION COLLECTION\nNOW AVAILABLE", 322, h*.475, 170, 42, {fontSize:13, fontWeight:600, color:"#fffaf3", z:7}));
    } else if (name === "split-focus") {
      state.background = "#8f765d";
      state.layers.push(photo(0, 0, w/2, h, ["#d2996e", "#76533d"]));
      state.layers.push(photo(w/2, 0, w/2, h, ["#3b4931", "#a39272"], {z:2}));
      state.layers.push(copy("A R O W W A I", 145, h*.46, 250, 32, {fontSize:18, fontWeight:700, color:"#fff", align:"center", letterSpacing:".22em", z:5}));
      state.layers.push(copy("SPRING / SUMMER\nA STUDY IN CONTRAST", 175, h*.515, 190, 55, {fontSize:11, fontWeight:600, color:"#fff", align:"center", letterSpacing:".1em", z:5}));
    } else if (name === "four-frames") {
      state.background = "#f7f5ef";
      const cellW=w/2, cellH=h/2;
      state.layers.push(photo(0, 0, cellW, cellH, ["#a78c6c", "#e5d2b7"]));
      state.layers.push(photo(cellW, 0, cellW, cellH, ["#e8e5dc", "#85908e"], {z:2}));
      state.layers.push(photo(0, cellH, cellW, cellH, ["#d9d9d0", "#6e6b61"], {z:3}));
      state.layers.push(photo(cellW, cellH, cellW, cellH, ["#ddb9a7", "#7f8d72"], {z:4}));
    } else if (name === "scrapbook") {
      state.background = "#eee4d5";
      state.layers.push(photo(-18, -12, w*.60, h*.48, ["#6d604d", "#b9a073"], {rotation:-3, radius:18, z:1}));
      state.layers.push(photo(w*.45, -20, w*.62, h*.53, ["#443b36", "#a4886d"], {rotation:4, radius:18, z:2}));
      state.layers.push(photo(-20, h*.42, w*.63, h*.51, ["#b57d3d", "#d9be91"], {rotation:3, radius:18, z:3}));
      state.layers.push(photo(w*.43, h*.46, w*.62, h*.56, ["#6e5943", "#c29678"], {rotation:-3, radius:18, z:4}));
      state.layers.push(copy("SUNDAY\nNOTES", 203, 300, 150, 80, {fontFamily:"'Instrument Serif', serif", fontSize:38, color:"#fffaf1", align:"center", rotation:-2, z:8}));
    } else if (name === "nine-mood") {
      state.background = "#f2eee5";
      const gap=0, margin=0, cellW=w/3, cellH=h/3;
      const palettes=[["#777","#ccc"],["#e4dfd1","#aaa"],["#4d4d4b","#999"],["#a69b83","#dfd7c7"],["#d0c6b4","#777"],["#ede9df","#c7bfaa"],["#cac1a8","#e9e1d0"],["#9d9b96","#dad7cf"]];
      let paletteIndex=0;
      for(let row=0;row<3;row++) for(let col=0;col<3;col++) {
        const x=margin+col*(cellW+gap), y=margin+row*(cellH+gap);
        if(row===1 && col===2) {
          state.layers.push(copy("MINIMAL         AESTHETIC", x+10, y+14, cellW-20, 25, {fontSize:10,fontWeight:700,z:5}));
          state.layers.push(copy("form.", x+12, y+cellH*.48, cellW-24, 60, {fontFamily:"'Instrument Serif', serif",fontSize:48,z:5}));
        } else {
          state.layers.push(photo(x,y,cellW,cellH,palettes[paletteIndex++],{z:row*3+col+1,filter:(row+col)%2===0?"grayscale(1)":"none"}));
        }
      }
    } else if (name === "portrait-notes") {
      state.background = "#a9abad";
      state.layers.push(photo(0, 0, w, h, ["#92989a", "#74553c"]));
      state.layers.push(copy("YOUR NAME", 42, 55, 250, 65, {fontFamily:"'Instrument Serif', serif",fontSize:58,color:"#fff",z:5}));
      state.layers.push(copy("CREATIVE SOUL  ↘", 45, 140, 190, 28, {fontSize:14,fontWeight:700,color:"#fff",letterSpacing:".08em",z:5}));
      state.layers.push(copy("SUNDAY BIKE RIDES  ↗", 285, 235, 210, 30, {fontSize:13,fontWeight:700,color:"#fff",align:"right",z:5}));
      state.layers.push(copy("DOG DAD  ↗", 48, 490, 170, 30, {fontSize:14,fontWeight:700,color:"#fff",z:5}));
      state.layers.push(copy("JAZZ LOVER  ♫", 320, 555, 180, 35, {fontSize:14,fontWeight:700,color:"#fff",align:"right",z:5}));
    } else if (name === "quiet-triptych") {
      buildQuietPhotoStack(3, false);
      return;
    } else if (name === "editorial") {
      state.background = "#d9d2c1";
      state.layers.push(photo(45, 55, w * 1.38, h - 110, ["#8aa09a", "#d9a489"]));
      state.layers.push(photo(w * 1.52, 65, w * .92, h * .42, ["#3f4b48", "#98b2ab"], {z:2}));
      state.layers.push(copy("Slow days,\nsoft light.",w*1.52,h*.58,w*1.14,150,{fontFamily:"'Instrument Serif', serif",fontSize:76,fontWeight:400,color:"#272725",z:3}));
    } else if (name === "panorama") {
      state.background = "#d7e1df";
      state.layers.push(photo(0, 0, w * 2.35, h, ["#5a7f83", "#dcb193"]));
      state.layers.push(copy("OUT THERE",w*1.8,h*.38,w*.92,100,{fontSize:54,fontWeight:700,color:"#172528",align:"center",letterSpacing:".12em",z:3}));
    } else if (name === "duo") {
      state.background = "#eaccc5";
      state.layers.push(photo(0,0,w,h,["#a27670","#e1a8a0"]));
      state.layers.push(photo(w,0,w,h,["#526c6a","#b4bbb1"],{z:2}));
      state.layers.push(copy("US / HERE",w*.72,h*.45,w*.62,65,{fontSize:30,fontWeight:700,color:"#fffaf1",align:"center",letterSpacing:".13em",z:3}));
    } else if (name === "wedding-story") {
      state.background = "#f6f1e8";
      state.layers.push(copy("THE WEDDING OF",72,62,390,25,{fontSize:14,fontWeight:700,align:"center",letterSpacing:".16em",color:"#75675d",z:20}));
      state.layers.push(copy("Emily & Marco",62,98,410,75,{fontFamily:"'Instrument Serif', serif",fontSize:58,align:"center",color:"#6f5e54",z:20}));
      state.layers.push(photo(105,190,330,330,["#bab5b0","#6b645f"],{filter:"grayscale(1) contrast(1.06)"}));
      state.layers.push(copy("25 MAY 2026",165,540,210,25,{fontSize:12,fontWeight:700,align:"center",letterSpacing:".12em",color:"#75675d",z:20}));
      state.layers.push(photo(w+35,65,w*1.28,h-125,["#7d5d4b","#d9b9a1"],{z:2}));
      state.layers.push(photo(w*1.86,120,245,255,["#ddc8b9","#9f776a"],{z:4}));
      state.layers.push(photo(w*2.54,0,w*1.34,h,["#4e4b42","#c4aa8d"],{z:3}));
      state.layers.push(copy("A DAY TO REMEMBER",w*2.1,545,360,28,{fontSize:13,fontWeight:700,align:"center",letterSpacing:".16em",color:"#75675d",z:20}));
      state.layers.push(photo(w*4+95,115,350,420,["#63715d","#d9d2b9"],{z:5}));
      state.layers.push(copy("FOREVER STARTS HERE",w*4+80,565,380,30,{fontFamily:"'Instrument Serif', serif",fontSize:28,align:"center",color:"#6f5e54",z:20}));
    } else if (name === "garden-flow") {
      state.background = "#f4f1e8";
      state.layers.push(photo(0,0,w*.88,h,["#66745f","#b9bd9d"]));
      state.layers.push(copy("GARDEN\nVOWS",60,55,300,110,{fontFamily:"'Instrument Serif', serif",fontSize:70,color:"#fffaf1",z:20}));
      state.layers.push(photo(w*.76,80,w*1.32,h*.46,["#bba98c","#e2d8c4"],{z:2}));
      state.layers.push(photo(w*1.15,h*.51,w*.72,h*.42,["#73836f","#c5c2a6"],{z:4}));
      state.layers.push(photo(w*2.02,0,w*.96,h,["#87947b","#d1c8ae"],{z:3}));
      state.layers.push(photo(w*2.73,125,w*1.38,h*.66,["#5b6d57","#c9c6ab"],{z:5}));
      state.layers.push(photo(w*3.82,40,w*.54,h*.38,["#d8cbb8","#8b7d6c"],{z:7}));
      state.layers.push(copy("WILD HEARTS / SOFT LIGHT",w*3.28,560,460,28,{fontSize:13,fontWeight:700,align:"center",letterSpacing:".14em",color:"#5a6655",z:20}));
      state.layers.push(photo(w*4.22,0,w*.72,h,["#6e7f68","#c7b99a"],{z:6}));
      state.layers.push(photo(w*4.75,75,w*1.18,h*.78,["#a29a7f","#e2d6c1"],{z:8}));
      state.layers.push(photo(w*5.38,445,w*.43,h*.27,["#556650","#b0ad8b"],{z:10}));
    } else if (name === "monochrome-vows") {
      state.background = "#171719";
      state.layers.push(photo(0,0,w,h,["#d5d5d5","#323232"],{filter:"grayscale(1) contrast(1.18)"}));
      state.layers.push(copy("SOFIA & LUCA",45,530,450,65,{fontFamily:"'Instrument Serif', serif",fontSize:54,color:"#fff",z:20}));
      state.layers.push(copy("JULY 18, 2026",48,600,210,22,{fontSize:11,fontWeight:700,color:"#fff",letterSpacing:".16em",z:20}));
      const g=12, sx=w+55, sy=80, cw=205, ch=245;
      state.layers.push(photo(sx,sy,cw,ch,["#eee","#676767"],{filter:"grayscale(1)",z:2}));
      state.layers.push(photo(sx+cw+g,sy,cw,ch,["#777","#ddd"],{filter:"grayscale(1)",z:3}));
      state.layers.push(photo(sx,sy+ch+g,cw,ch,["#aaa","#333"],{filter:"grayscale(1)",z:4}));
      state.layers.push(photo(sx+cw+g,sy+ch+g,cw,ch,["#eee","#555"],{filter:"grayscale(1)",z:5}));
      state.layers.push(photo(w*2,0,w*.52,h,["#bfbfbf","#4a4a4a"],{filter:"grayscale(1) contrast(1.12)",z:2}));
      state.layers.push(photo(w*2.52,0,w*.48,h,["#ededed","#565656"],{filter:"grayscale(1) contrast(1.12)",z:3}));
      state.layers.push(photo(w*3+85,90,w-170,h-180,["#888","#dedede"],{filter:"grayscale(1) contrast(1.15)",z:4}));
      state.layers.push(copy("ONE MOMENT / FOREVER",w*3+95,565,w-190,25,{fontSize:12,fontWeight:700,color:"#fff",align:"center",letterSpacing:".14em",z:20}));
      state.layers.push(photo(w*4,0,w,h,["#d4d4d4","#303030"],{filter:"grayscale(1) contrast(1.18)",z:5}));
    } else if (name === "minimal-frames") {
      state.background = "#f8f5ee";
      state.layers.push(photo(115,135,310,405,["#8d887f","#d3ccc1"],{filter:"grayscale(1)"}));
      state.layers.push(copy("OUR STORY",130,65,280,35,{fontFamily:"'Instrument Serif', serif",fontSize:34,align:"center",color:"#665d55",z:20}));
      state.layers.push(photo(w+35,80,w*.72,h*.72,["#9b8877","#dbcbb8"],{z:2}));
      state.layers.push(photo(w*1.68,260,w*.54,h*.38,["#d3c5b5","#75685f"],{z:4}));
      state.layers.push(photo(w*2.22,100,w*.58,h*.66,["#b9b0a5","#6c625b"],{filter:"grayscale(1)",z:3}));
      state.layers.push(photo(w*2.86,165,w*.42,h*.44,["#d8d0c3","#8e8073"],{z:5}));
      state.layers.push(copy("THE QUIET DETAILS",w*2.42,565,w*.62,30,{fontSize:12,fontWeight:700,align:"center",letterSpacing:".15em",color:"#6a6058",z:20}));
      state.layers.push(photo(w*3.38,70,w*.76,h*.78,["#77766f","#d1c9bc"],{filter:"grayscale(1)",z:6}));
      state.layers.push(photo(w*4.2,140,w*.58,h*.56,["#9a8c80","#e0d5c6"],{z:7}));
      state.layers.push(copy("EVERY FRAME, A MEMORY",w*4.04,565,w*.9,30,{fontFamily:"'Instrument Serif', serif",fontSize:28,align:"center",color:"#665d55",z:20}));
    } else if (name === "collage-reel") {
      state.background = "#eee8dd";
      state.layers.push(copy("LOVE / IN MOTION",48,48,430,60,{fontFamily:"'Instrument Serif', serif",fontSize:52,color:"#6e5c4f",z:40}));
      state.layers.push(photo(-30,145,w*.72,h*.62,["#788170","#c9bba7"],{rotation:-3,z:1}));
      state.layers.push(photo(w*.48,80,w*.68,h*.54,["#a17d67","#dfc8b4"],{rotation:2,z:2}));
      state.layers.push(photo(w*.92,305,w*.52,h*.43,["#d6c9b8","#6c7768"],{rotation:-4,z:4}));
      state.layers.push(photo(w*1.32,35,w*.88,h*.76,["#71806f","#c8bba6"],{rotation:2,z:3}));
      state.layers.push(photo(w*2.12,195,w*.56,h*.48,["#c6aa94","#7a6356"],{rotation:-3,z:6}));
      state.layers.push(photo(w*2.57,25,w*.86,h*.69,["#64725f","#d7cbb7"],{rotation:3,z:5}));
      state.layers.push(photo(w*3.22,325,w*.54,h*.42,["#b59c86","#e0d5c4"],{rotation:-2,z:8}));
      state.layers.push(photo(w*3.62,70,w*.82,h*.75,["#7a796b","#c9b9a2"],{rotation:2,z:7}));
      state.layers.push(photo(w*4.38,10,w*.52,h*.46,["#d8c7b1","#6e7a69"],{rotation:-3,z:10}));
      state.layers.push(photo(w*4.68,275,w*.78,h*.62,["#8d6f5c","#d9c4ae"],{rotation:3,z:9}));
      state.layers.push(photo(w*5.3,95,w*.62,h*.72,["#61705e","#d1c0a8"],{rotation:-2,z:11}));
      state.layers.push(copy("THE BEST IS YET TO COME",w*4.72,575,w,30,{fontSize:12,fontWeight:700,align:"center",letterSpacing:".16em",color:"#6e5c4f",z:40}));
    } else if (name === "border-mosaic") {
      state.background = "#f7f4ee";
      const palettes = [
        ["#756d5b","#d9c7aa"],["#a28a73","#e1d2bd"],["#5f6258","#c2b49b"],["#c6b59d","#7b6e5f"],
        ["#8b7e6a","#dfcfb8"],["#b69c80","#6a6257"],["#d9c9b3","#85806e"],["#6e735f","#c7b89f"],
      ];
      const tile = (slide,x,y,width,height,index,z=1) => state.layers.push(photo(slide*w+x,y,width,height,palettes[index%palettes.length],{z}));
      tile(0,14,14,160,270,0); tile(0,180,14,346,270,1); tile(0,14,290,250,371,2); tile(0,270,290,256,371,3);
      tile(1,14,14,512,647,4);
      tile(2,14,14,250,250,5); tile(2,270,14,256,250,6); tile(2,14,270,170,391,7); tile(2,190,270,336,391,0);
      tile(3,14,14,512,350,1); tile(3,14,370,320,291,2); tile(3,340,370,186,291,3);
      tile(4,14,14,512,647,6);
      tile(5,14,14,250,647,7); tile(5,270,14,256,318,4); tile(5,270,338,256,323,5);
      state.layers.push(copy("A WEEKEND TO REMEMBER",w*2+32,35,430,28,{fontSize:12,fontWeight:700,letterSpacing:".15em",color:"#fff",z:30}));
    } else if (name === "fullbleed-mosaic") {
      state.background = "#8c806d";
      const palettes = [
        ["#746c59","#d6c3a4"],["#a08a72","#e5d5bd"],["#585e55","#c8b99e"],["#cfbda3","#74695b"],
        ["#8d7b65","#e1cfb3"],["#b29578","#625b52"],["#d8c7af","#7d796a"],["#68715f","#c8b99d"],
      ];
      const tile = (slide,x,y,width,height,index,z=1) => state.layers.push(photo(slide*w+x,y,width,height,palettes[index%palettes.length],{z}));
      tile(0,0,0,200,330,0); tile(0,200,0,340,330,1); tile(0,0,330,285,345,2); tile(0,285,330,255,345,3);
      tile(1,0,0,540,675,4);
      tile(2,0,0,235,270,5); tile(2,235,0,305,270,6); tile(2,0,270,190,405,7); tile(2,190,270,350,405,0);
      tile(3,0,0,540,365,1); tile(3,0,365,330,310,2); tile(3,330,365,210,310,3);
      tile(4,0,0,540,675,6);
      tile(5,0,0,280,675,7); tile(5,280,0,260,340,4); tile(5,280,340,260,335,5);
    } else if (name === "overlap-story") {
      state.background = "#e9e1d6";
      const basePalettes = [["#867564","#d8c2a8"],["#a48b72","#e5d4bc"],["#667066","#c5b69e"],["#b09377","#dfceb7"],["#6d675e","#cfc0aa"],["#927963","#e3d0b7"]];
      basePalettes.forEach((palette,index) => state.layers.push(photo(index*w,0,w,h,palette,{z:1}))); 
      state.layers.push(photo(w*.58,58,w*.62,h*.48,["#dbcbb7","#75685c"],{z:8}));
      state.layers.push(photo(w*1.52,330,w*.58,h*.42,["#647166","#cfbea5"],{z:9}));
      state.layers.push(photo(w*2.44,72,w*.72,h*.55,["#b4977a","#e5d3bd"],{z:10}));
      state.layers.push(photo(w*3.14,360,w*.52,h*.38,["#d6c4ad","#70665d"],{z:11}));
      state.layers.push(photo(w*3.72,35,w*.66,h*.50,["#778072","#d4c3a8"],{z:12}));
      state.layers.push(photo(w*4.55,265,w*.72,h*.54,["#a8876c","#e4d1b8"],{z:13}));
      state.layers.push(photo(w*5.28,70,w*.55,h*.40,["#d8c4ad","#6a665c"],{z:14}));
      state.layers.push(copy("LOVE, IN EVERY FRAME",45,42,430,48,{fontFamily:"'Instrument Serif', serif",fontSize:40,color:"#fff",z:30}));
      state.layers.push(copy("TOGETHER / ALWAYS",w*5+105,610,330,24,{fontSize:12,fontWeight:700,align:"center",letterSpacing:".16em",color:"#fff",z:30}));
    } else if (name === "family-tapestry") {
      state.background = "#ede4d9";
      const palettes = [["#9d826d","#dfc9b5"],["#c1a88f","#6e655a"],["#d8c3ad","#8b7664"],["#776e62","#d0bba5"],["#aa8e76","#ead6c0"],["#667064","#cbbba6"]];
      const tile = (slide,x,y,width,height,index,z=1) => state.layers.push(photo(slide*w+x,y,width,height,palettes[index%palettes.length],{z}));
      tile(0,0,0,225,675,0); tile(0,225,0,315,300,1); tile(0,225,300,315,375,2);
      tile(1,0,0,270,335,3); tile(1,270,0,270,335,4); tile(1,0,335,540,340,5);
      tile(2,0,0,540,675,1); tile(2,125,115,290,355,4,8);
      tile(3,0,0,320,675,2); tile(3,320,0,220,255,5); tile(3,320,255,220,420,0);
      tile(4,0,0,540,365,3); tile(4,0,365,245,310,4); tile(4,245,365,295,310,1);
      state.layers.push(copy("HOME IS ALL OF US",w*2+125,505,290,32,{fontFamily:"'Instrument Serif', serif",fontSize:27,align:"center",color:"#fff",z:20}));
    } else if (name === "coastal-echoes") {
      state.background = "#dbe4e2";
      const palettes = [["#8fa7a7","#e7d8c3"],["#bdcaca","#d6bfa0"],["#6f8b8c","#d8d2c3"],["#dcc8ad","#81999a"],["#a7b9b7","#ead7bd"],["#759091","#d8c4aa"]];
      state.layers.push(photo(0,0,w*.78,h,palettes[0]));
      state.layers.push(photo(w*.58,85,w*.72,h*.48,palettes[1],{z:5}));
      state.layers.push(photo(w*1.18,310,w*.62,h*.44,palettes[2],{z:6}));
      state.layers.push(photo(w*1.68,0,w*.72,h,palettes[3],{z:2}));
      state.layers.push(photo(w*2.22,75,w*.84,h*.56,palettes[4],{z:7}));
      state.layers.push(photo(w*2.85,360,w*.58,h*.40,palettes[5],{z:8}));
      state.layers.push(photo(w*3.26,0,w*.66,h,palettes[0],{z:3}));
      state.layers.push(photo(w*3.72,95,w*.82,h*.52,palettes[2],{z:9}));
      state.layers.push(photo(w*4.38,320,w*.58,h*.44,palettes[1],{z:10}));
      state.layers.push(photo(w*4.78,0,w*.72,h,palettes[4],{z:4}));
      state.layers.push(photo(w*5.34,95,w*.52,h*.45,palettes[5],{z:11}));
      state.layers.push(copy("COASTAL ECHOES",45,48,360,48,{fontFamily:"'Instrument Serif', serif",fontSize:42,color:"#fff",z:30}));
      state.layers.push(copy("SALT AIR / SOFT LIGHT",w*4.95,600,430,24,{fontSize:12,fontWeight:700,align:"center",letterSpacing:".16em",color:"#fff",z:30}));
    }
    updateArtboardGeometry();
    renderLayers();
    scheduleSave();
    setTimeout(fitCanvas, 50);
  }

  function buildQuietPhotoStack(count, withHistory = true) {
    const safeCount = Math.max(2, Math.min(5, Number(count) || 3));
    if (withHistory) pushHistory();
    const previousSlots = state.layers.filter((layer) => layer.templateSlot);
    const customLayers = state.layers.filter((layer) => !layer.templateSlot && !layer.templateOwned);
    state.activeTemplate = "quiet-triptych";
    state.templatePhotoCount = safeCount;
    state.ratio = "4:5";
    state.slides = 1;
    state.background = "#efefec";
    state.slideBackgrounds = [];
    state.backgroundStart = 0;
    state.backgroundSpan = "all";
    state.selectedId = null;

    const { w, h } = ratioInfo();
    const slotHeight = h / safeCount;
    const palettes = [
      ["#d7d7d7", "#4b4b4b"],
      ["#7a7a7a", "#ededed"],
      ["#efefef", "#484848"],
      ["#5d5d5d", "#d3d3d3"],
      ["#dadada", "#343434"],
    ];
    const slots = Array.from({ length: safeCount }, (_, index) => ({
      id: previousSlots[index]?.id || uid(),
      type: "image",
      src: previousSlots[index]?.src || makeStripPlaceholder(palettes[index], index),
      x: 0,
      y: index * slotHeight,
      w,
      h: slotHeight,
      z: index + 1,
      opacity: 1,
      radius: 0,
      fit: "cover",
      rotation: 0,
      filter: previousSlots[index]?.filter || "grayscale(1) contrast(1.08)",
      templateSlot: true,
      imageScale: previousSlots[index]?.imageScale || 1,
      focusX: previousSlots[index]?.focusX ?? 50,
      focusY: previousSlots[index]?.focusY ?? 50,
      hidden:false,
      locked:false,
    }));
    const labels = [
      {
        id: uid(), type:"text", text:"SUMMER DAYS PASS\nSLOWLY, LEAVING SOFT\nMEMORIES BEHIND.",
        x:24, y:24, w:235, h:62, z:50, fontFamily:"'DM Sans', sans-serif", fontSize:13,
        fontWeight:700, color:"#171719", align:"left", opacity:1, rotation:0, templateOwned:true,
      },
      {
        id: uid(), type:"text", text:"THE OCEAN BREEZE BRINGS\nCALM THOUGHTS.",
        x:w-252, y:slotHeight+26, w:228, h:48, z:50, fontFamily:"'DM Sans', sans-serif", fontSize:13,
        fontWeight:700, color:"#171719", align:"right", opacity:1, rotation:0, templateOwned:true,
      },
      {
        id: uid(), type:"text", text:"@YOURSTORY",
        x:w-176, y:h-40, w:152, h:25, z:50, fontFamily:"'DM Sans', sans-serif", fontSize:12,
        fontWeight:700, color:"#fff", align:"right", opacity:1, rotation:0, templateOwned:true,
      },
    ];
    state.layers = [...slots, ...labels, ...customLayers];
    updateArtboardGeometry();
    renderLayers();
    scheduleSave();
    setTimeout(fitCanvas, 50);
  }

  function makeStripPlaceholder(colors, index = 0) {
    const [a, b] = colors;
    const flip = index % 2 ? -1 : 1;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="${flip}"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="n"><feTurbulence baseFrequency=".8" numOctaves="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .12"/></feComponentTransfer></filter></defs><rect width="1200" height="420" fill="url(#g)"/><path d="M-80 ${index%2?370:90} Q250 ${index%2?40:390} 560 210 T1280 ${index%2?80:350} V500 H-80Z" fill="rgba(255,255,255,.16)"/><path d="M-120 ${index%2?80:350} Q300 180 650 ${index%2?350:60} T1320 230" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="170"/><rect width="1200" height="420" filter="url(#n)"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function makePlaceholder(colors, width, height) {
    const [a, b] = colors;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(10,width)}" height="${Math.max(10,height)}" viewBox="0 0 800 800" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="n"><feTurbulence baseFrequency=".65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .09"/></feComponentTransfer></filter></defs><rect width="800" height="800" fill="url(#g)"/><circle cx="630" cy="160" r="190" fill="rgba(255,255,255,.16)"/><path d="M0 650 Q220 400 410 590 T800 470 V800 H0Z" fill="rgba(20,30,30,.20)"/><rect width="800" height="800" filter="url(#n)" opacity=".45"/></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  function syncFrameDrawMode() {
    const button = $("#drawFrameButton");
    if (!button) return;
    button.classList.toggle("active", !!state.frameDrawMode);
    button.setAttribute("aria-pressed", String(!!state.frameDrawMode));
    button.title = state.frameDrawMode
      ? "Drawing photo frames — drag on the canvas, press Esc to finish"
      : "Draw a photo frame anywhere on the canvas";
    artboard.classList.toggle("frame-draw-mode", !!state.frameDrawMode);
  }

  function setFrameDrawMode(active, announce = true) {
    state.frameDrawMode = !!active;
    state.cropModeId = null;
    if (!state.frameDrawMode && drag?.mode === "draw-frame") {
      drag.draft?.remove();
      drag = null;
      window.removeEventListener("pointermove", pointerMove);
    }
    syncFrameDrawMode();
    if (announce) showToast(state.frameDrawMode ? "Drag anywhere on the canvas to draw photo frames · Esc to finish" : "Photo frame tool closed");
  }

  function canvasPoint(clientX, clientY) {
    const rect = artboard.getBoundingClientRect();
    const { w, h } = ratioInfo();
    return {
      x: Math.max(0, Math.min(w * state.slides, (clientX - rect.left) / rect.width * w * state.slides)),
      y: Math.max(0, Math.min(h, (clientY - rect.top) / rect.height * h)),
    };
  }

  function startFrameDraw(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = canvasPoint(event.clientX, event.clientY);
    pushHistory();
    const draft = document.createElement("div");
    draft.className = "frame-draft";
    Object.assign(draft.style, { left:`${point.x}px`, top:`${point.y}px`, width:"0px", height:"0px" });
    artboard.appendChild(draft);
    drag = {
      mode:"draw-frame", startCanvasX:point.x, startCanvasY:point.y,
      x:point.x, y:point.y, w:0, h:0, moved:false, draft,
    };
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerEnd, { once:true });
  }

  function clearSnapGuides() {
    $$(".snap-guide", artboard).forEach((guide) => guide.remove());
  }

  function showSnapGuides(vertical = [], horizontal = []) {
    clearSnapGuides();
    [...new Set(vertical)].forEach((x) => {
      const guide = document.createElement("i");
      guide.className = "snap-guide vertical";
      guide.style.left = `${x}px`;
      artboard.appendChild(guide);
    });
    [...new Set(horizontal)].forEach((y) => {
      const guide = document.createElement("i");
      guide.className = "snap-guide horizontal";
      guide.style.top = `${y}px`;
      artboard.appendChild(guide);
    });
  }

  function snapTargets(excludeId) {
    const { w, h } = ratioInfo();
    const x = [0, w * state.slides, w * state.slides / 2];
    for (let slide = 0; slide <= state.slides; slide++) {
      x.push(slide * w);
      if (slide < state.slides) x.push(slide * w + w / 2);
    }
    const y = [0, h / 2, h];
    state.layers.filter((layer) => layer.id !== excludeId && !layer.hidden).forEach((layer) => {
      x.push(layer.x, layer.x + layer.w / 2, layer.x + layer.w);
      y.push(layer.y, layer.y + layer.h / 2, layer.y + layer.h);
    });
    return { x, y };
  }

  function closestSnap(anchors, targets) {
    let match = null;
    anchors.forEach((anchor) => targets.forEach((target) => {
      const distance = Math.abs(target - anchor.value);
      if (distance <= SNAP_THRESHOLD && (!match || distance < match.distance)) match = { distance, delta:target - anchor.value, guide:target };
    }));
    return match;
  }

  function snapLayerPosition(layer, x, y) {
    const targets = snapTargets(layer.id);
    const xMatch = closestSnap([
      {value:x}, {value:x + layer.w / 2}, {value:x + layer.w},
    ], targets.x);
    const yMatch = closestSnap([
      {value:y}, {value:y + layer.h / 2}, {value:y + layer.h},
    ], targets.y);
    return {
      x:x + (xMatch?.delta || 0), y:y + (yMatch?.delta || 0),
      vertical:xMatch ? [xMatch.guide] : [], horizontal:yMatch ? [yMatch.guide] : [],
    };
  }

  function pointerStart(event) {
    if (state.frameDrawMode) { startFrameDraw(event); return; }
    const layerElement = event.target.closest(".canvas-layer");
    if (!layerElement) { state.selectedId = null; state.cropModeId = null; renderLayers(); return; }
    event.preventDefault();
    const id = layerElement.dataset.id;
    if (state.selectedId !== id) selectLayer(id);
    const layer = state.layers.find((item) => item.id === id);
    if (layer.locked) { showToast("Unlock this layer to edit it"); return; }
    pushHistory();
    drag = {
      id,
      mode: state.cropModeId === id && isVisualLayer(layer) ? "image-pan" : (event.target.dataset.resize ? "resize" : "move"),
      startX: event.clientX,
      startY: event.clientY,
      x: layer.x, y: layer.y, w: layer.w, h: layer.h,
      aspect: layer.w / layer.h,
      focusX: layer.focusX ?? 50,
      focusY: layer.focusY ?? 50,
      moved: false,
    };
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", pointerEnd, { once: true });
  }

  function pointerMove(event) {
    if (!drag) return;
    if (drag.mode === "draw-frame") {
      const point = canvasPoint(event.clientX, event.clientY);
      drag.x = Math.min(drag.startCanvasX, point.x);
      drag.y = Math.min(drag.startCanvasY, point.y);
      drag.w = Math.abs(point.x - drag.startCanvasX);
      drag.h = Math.abs(point.y - drag.startCanvasY);
      drag.moved = drag.w + drag.h > 4;
      Object.assign(drag.draft.style, { left:`${drag.x}px`, top:`${drag.y}px`, width:`${drag.w}px`, height:`${drag.h}px` });
      return;
    }
    const layer = state.layers.find((item) => item.id === drag.id);
    if (!layer) return;
    const scale = state.zoom / 100;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    drag.moved = Math.abs(dx) + Math.abs(dy) > 1;
    if (drag.mode === "image-pan") {
      layer.focusX = Math.max(0, Math.min(100, drag.focusX - dx / layer.w * 100));
      layer.focusY = Math.max(0, Math.min(100, drag.focusY - dy / layer.h * 100));
      const image = $(`.canvas-layer[data-id="${layer.id}"] img`);
      if (image) {
        image.style.objectPosition = `${layer.focusX}% ${layer.focusY}%`;
        image.style.transformOrigin = `${layer.focusX}% ${layer.focusY}%`;
      }
    } else if (drag.mode === "move") {
      const snapped = snapLayerPosition(layer, drag.x + dx, drag.y + dy);
      layer.x = snapped.x;
      layer.y = snapped.y;
      showSnapGuides(snapped.vertical, snapped.horizontal);
    } else {
      let newW = Math.max(45, drag.w + dx);
      let newH = Math.max(35, drag.h + dy);
      if (event.shiftKey || (isVisualLayer(layer) && !layer.userFrame)) newH = newW / drag.aspect;
      const targets = snapTargets(layer.id);
      const rightMatch = closestSnap([{value:layer.x + newW}], targets.x);
      const bottomMatch = closestSnap([{value:layer.y + newH}], targets.y);
      if (rightMatch) newW = Math.max(45, newW + rightMatch.delta);
      if (bottomMatch && !(event.shiftKey || (isVisualLayer(layer) && !layer.userFrame))) newH = Math.max(35, newH + bottomMatch.delta);
      showSnapGuides(rightMatch ? [rightMatch.guide] : [], bottomMatch ? [bottomMatch.guide] : []);
      layer.w = newW;
      layer.h = newH;
    }
    const element = $(`.canvas-layer[data-id="${layer.id}"]`);
    if (element && drag.mode !== "image-pan") Object.assign(element.style, { left:`${layer.x}px`, top:`${layer.y}px`, width:`${layer.w}px`, height:`${layer.h}px` });
  }

  function pointerEnd() {
    clearSnapGuides();
    if (drag?.mode === "draw-frame") {
      const drawing = drag;
      drawing.draft?.remove();
      const { w:canvasW, h:canvasH } = ratioInfo();
      let { x, y, w, h } = drawing;
      if (!drawing.moved || w < 12 || h < 12) {
        w = Math.min(220, canvasW * .42);
        h = Math.min(170, canvasH * .28);
        x = Math.max(0, Math.min(canvasW * state.slides - w, drawing.startCanvasX - w / 2));
        y = Math.max(0, Math.min(canvasH - h, drawing.startCanvasY - h / 2));
      }
      const layer = {
        id:uid(), type:"image", src:makePlaceholder(["#d9d6cc", "#929791"], w, h),
        x, y, w, h, z:nextZ(), opacity:1, radius:0, fit:"cover", rotation:0,
        templateSlot:true, userFrame:true, imageScale:1, focusX:50, focusY:50, hidden:false, locked:false,
      };
      state.layers.push(layer);
      state.selectedId = layer.id;
      drag = null;
      window.removeEventListener("pointermove", pointerMove);
      renderLayers();
      scheduleSave();
      updateHistoryButtons();
      showToast("Photo frame created · drag media into it or draw another");
      return;
    }
    if (drag && !drag.moved) state.history.pop();
    drag = null;
    window.removeEventListener("pointermove", pointerMove);
    syncProperties();
    scheduleSave();
    updateHistoryButtons();
  }

  async function drawLayer(ctx, layer, offsetX, scale, activeVideo = null) {
    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1;
    const centerX = (layer.x - offsetX + layer.w / 2) * scale;
    const centerY = (layer.y + layer.h / 2) * scale;
    ctx.translate(centerX, centerY);
    ctx.rotate((layer.rotation || 0) * Math.PI / 180);
    const x = -layer.w * scale / 2;
    const y = -layer.h * scale / 2;
    const w = layer.w * scale;
    const h = layer.h * scale;

    if (isVisualLayer(layer)) {
      const visual = layer.type === "video"
        ? (activeVideo?.layerId === layer.id ? activeVideo.sample : (layer.poster ? await loadImage(layer.poster) : null))
        : await loadImage(layer.src);
      if (!visual) { ctx.restore(); return; }
      roundedRect(ctx, x, y, w, h, (layer.radius || 0) * scale);
      ctx.clip();
      ctx.filter = layer.filter || "none";
      const sourceWidth = visual.displayWidth || visual.naturalWidth || visual.videoWidth;
      const sourceHeight = visual.displayHeight || visual.naturalHeight || visual.videoHeight;
      const imageAspect = sourceWidth / sourceHeight;
      const boxAspect = layer.w / layer.h;
      let drawW, drawH;
      if ((layer.fit || "cover") === "contain") {
        if (imageAspect > boxAspect) { drawW = w; drawH = w / imageAspect; } else { drawH = h; drawW = h * imageAspect; }
      } else {
        if (imageAspect > boxAspect) { drawH = h; drawW = h * imageAspect; } else { drawW = w; drawH = w / imageAspect; }
      }
      const imageScale = layer.imageScale || 1;
      drawW *= imageScale;
      drawH *= imageScale;
      const focusX = (layer.focusX ?? 50) / 100;
      const focusY = (layer.focusY ?? 50) / 100;
      const drawX = drawW >= w ? x - (drawW - w) * focusX : x + (w - drawW) / 2;
      const drawY = drawH >= h ? y - (drawH - h) * focusY : y + (h - drawH) / 2;
      if (typeof visual.draw === "function") visual.draw(ctx, 0, 0, sourceWidth, sourceHeight, drawX, drawY, drawW, drawH);
      else ctx.drawImage(visual, drawX, drawY, drawW, drawH);
    } else {
      const fontFamily = layer.fontFamily || "'DM Sans', sans-serif";
      ctx.font = `${layer.fontWeight || 400} ${layer.fontSize * scale}px ${fontFamily}`;
      ctx.fillStyle = layer.color;
      ctx.textAlign = layer.align || "left";
      ctx.textBaseline = "top";
      const anchorX = layer.align === "center" ? 0 : layer.align === "right" ? w/2 : x;
      const lines = wrapText(ctx, layer.text, w);
      const lineHeight = layer.fontSize * scale * 1.02;
      lines.forEach((line, index) => ctx.fillText(line, anchorX, y + index * lineHeight));
    }
    ctx.restore();
  }

  function roundedRect(ctx, x, y, w, h, radius) {
    const r = Math.min(radius, w/2, h/2);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function wrapText(ctx, text, maxWidth) {
    const final = [];
    text.split("\n").forEach((paragraph) => {
      const words = paragraph.split(" ");
      let line = "";
      words.forEach((word) => {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) { final.push(line); line = word; }
        else line = test;
      });
      final.push(line);
    });
    return final;
  }

  function loadImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const pending = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => { imageCache.delete(src); reject(new Error("Image could not be loaded")); };
      image.src = src;
    });
    imageCache.set(src, pending);
    return pending;
  }

  async function renderSlideIntoContext(ctx, index, outW, outH, activeVideo = null) {
    const info = ratioInfo();
    ctx.clearRect(0, 0, outW, outH);
    ctx.fillStyle = backgroundColorForSlide(index);
    ctx.fillRect(0, 0, outW, outH);
    const scale = outW / info.w;
    const offset = index * info.w;
    const ordered = [...state.layers].filter((layer) => !layer.hidden).sort((a,b) => a.z-b.z);
    for (const layer of ordered) await drawLayer(ctx, layer, offset, scale, activeVideo);
  }

  async function renderSlide(index, preview = false) {
    await document.fonts.ready;
    const info = ratioInfo();
    const canvas = document.createElement("canvas");
    const outW = preview ? info.w : info.exportW;
    const outH = preview ? info.h : info.exportH;
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    await renderSlideIntoContext(ctx, index, outW, outH);
    return canvas;
  }

  function videoLayersForSlide(index) {
    const { w, h } = ratioInfo();
    const left = index * w;
    const right = left + w;
    return state.layers.filter((layer) => layer.type === "video" && !layer.hidden && layer.opacity !== 0
      && layer.x < right && layer.x + layer.w > left && layer.y < h && layer.y + layer.h > 0);
  }

  async function sourceBlobForLayer(layer) {
    const media = state.media.find((item) => item.id === layer.mediaId);
    if (media?.blob instanceof Blob) return media.blob;
    const response = await fetch(layer.src);
    if (!response.ok) throw new Error("Video source is unavailable");
    return response.blob();
  }

  async function renderVideoSlide(index, layer, onProgress) {
    if (!window.SpetlyVideo?.transcodeToInstagramMp4) throw new Error("Video export engine is unavailable");
    await document.fonts.ready;
    const info = ratioInfo();
    const canvas = document.createElement("canvas");
    canvas.width = info.exportW;
    canvas.height = info.exportH;
    const ctx = canvas.getContext("2d", { alpha:false });
    const sourceBlob = await sourceBlobForLayer(layer);
    return window.SpetlyVideo.transcodeToInstagramMp4({
      blob:sourceBlob,
      width:info.exportW,
      height:info.exportH,
      onProgress,
      renderFrame:async (sample) => {
        await renderSlideIntoContext(ctx, index, info.exportW, info.exportH, {layerId:layer.id, sample});
        return canvas;
      },
    });
  }

  async function openPreview() {
    const strip = $("#previewStrip");
    strip.innerHTML = "";
    showToast("Building preview…");
    for (let i = 0; i < state.slides; i++) strip.appendChild(await renderSlide(i, true));
    state.previewIndex = 0;
    updatePreviewPosition();
    $("#previewDialog").showModal();
  }

  function updatePreviewPosition() {
    const viewportWidth = window.innerWidth <= 760 ? 280 : 300;
    $("#previewStrip").style.transform = `translateX(-${state.previewIndex * viewportWidth}px)`;
    const dots = $("#previewDots");
    dots.innerHTML = Array.from({length:state.slides}, (_,i) => `<i class="${i===state.previewIndex?'active':''}"></i>`).join("");
  }

  function openExport() {
    const videoSlideCount = Array.from({length:state.slides}, (_, index) => videoLayersForSlide(index).length > 0).filter(Boolean).length;
    $("#exportSummaryTitle").textContent = `${state.slides} high-quality ${state.slides === 1 ? "slide" : "slides"}`;
    $("#exportStack").innerHTML = Array.from({length:Math.min(state.slides,4)}, (_,i) => `<i style="--rotate:${(i-(state.slides-1)/2)*5}deg"></i>`).join("");
    $("#exportAsZip").closest(".zip-option").classList.toggle("hidden", state.slides === 1);
    $("#confirmExport span").textContent = state.slides === 1 ? "Download slide" : "Download all slides";
    $("#videoExportNote").classList.toggle("hidden", videoSlideCount === 0);
    $("#exportDialog").showModal();
  }

  async function exportAll() {
    const button = $("#confirmExport");
    const original = button.innerHTML;
    const format = $("#exportFormat").value;
    const quality = Number($("#exportQuality").value) / 100;
    const zipEnabled = state.slides > 1 && $("#exportAsZip").checked;
    const zip = zipEnabled ? new JSZip() : null;
    const safeTitle = safeFilename(state.title, "carousel");
    button.disabled = true;
    let mutedVideo = false;
    try {
      for (let i = 0; i < state.slides; i++) {
        const videoLayers = videoLayersForSlide(i);
        if (videoLayers.length > 1) throw new Error(`Slide ${i + 1} contains more than one video. Keep one video per slide for Instagram export.`);
        let blob;
        let extension;
        if (videoLayers.length === 1) {
          button.querySelector("span").textContent = `Encoding video ${i+1} of ${state.slides}…`;
          const result = await renderVideoSlide(i, videoLayers[0], (progress) => {
            button.querySelector("span").textContent = `Encoding slide ${i+1} · ${Math.round(progress * 100)}%`;
          });
          blob = result.blob;
          mutedVideo ||= result.muted;
          extension = "mp4";
        } else {
          button.querySelector("span").textContent = `Rendering ${i+1} of ${state.slides}…`;
          const canvas = await renderSlide(i);
          blob = await new Promise((resolve) => canvas.toBlob(resolve, `image/${format}`, quality));
          extension = format === "jpeg" ? "jpg" : "png";
        }
        const filename = `${safeTitle}-${String(i+1).padStart(2,"0")}.${extension}`;
        if (zip) zip.file(filename, blob);
        else downloadBlob(blob, filename);
      }
      if (zip) {
        button.querySelector("span").textContent = "Packing ZIP…";
        downloadBlob(await zip.generateAsync({type:"blob", compression:"STORE"}), `${safeTitle}.zip`);
      }
      $("#exportDialog").close();
      showToast(mutedVideo ? "Export complete · video audio was not supported by this browser" : "Carousel exported in Instagram posting order");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Video export failed");
    } finally {
      button.innerHTML = original;
      button.disabled = false;
    }
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function photoFrameAtPoint(clientX, clientY) {
    return [...artboard.querySelectorAll(".canvas-layer:is(.image-layer,.video-layer)")].reverse().find((element) => {
      const rect = element.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }) || null;
  }

  function bindEvents() {
    $("#importProjectButton").addEventListener("click", () => $("#projectImportInput").click());
    $("#projectImportInput").addEventListener("change", (event) => importProjectBackup(event.target.files[0]));
    $$(".rail-button").forEach((button) => button.addEventListener("click", () => {
      const same = button.classList.contains("active");
      const wasOpen = $(".left-panel").classList.contains("open");
      switchPanel(button.dataset.panel);
      if (window.innerWidth <= 760 && same && wasOpen) $(".left-panel").classList.remove("open");
    }));
    $("#mediaInput").addEventListener("change", (event) => handleFiles(event.target.files));
    $$(".add-text-card").forEach((button) => button.addEventListener("click", () => addText(button.dataset.textStyle)));
    $$(".template-card").forEach((button) => button.addEventListener("click", () => {
      $$(".template-card").forEach((item) => item.classList.toggle("selected", item === button));
      applyTemplate(button.dataset.template);
    }));
    $$("[data-template-group]").forEach((button) => button.addEventListener("click", () => {
      const group = button.dataset.templateGroup;
      $$("[data-template-group]").forEach((item) => item.classList.toggle("active", item === button));
      $$(".template-card").forEach((card) => card.classList.toggle("template-hidden", card.dataset.group !== group));
    }));
    $("#templatePhotoCountSelect").addEventListener("change", (event) => buildQuietPhotoStack(event.target.value));
    $$("#colorGrid button").forEach((button) => button.addEventListener("click", () => setBackground(button.dataset.color)));
    $("#customColor").addEventListener("change", (event) => setBackground(event.target.value));
    $("#backgroundStart").addEventListener("change", (event) => {
      state.backgroundStart = Number(event.target.value) || 0;
      syncBackgroundControls();
    });
    $$("[data-bg-span]").forEach((button) => button.addEventListener("click", () => {
      state.backgroundSpan = button.dataset.bgSpan;
      if (state.backgroundSpan === "all") state.backgroundStart = 0;
      syncBackgroundControls();
    }));
    $$("[data-ratio]").forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.ratio === state.ratio) return;
      pushHistory(); state.ratio = button.dataset.ratio; updateArtboardGeometry(); renderLayers(); scheduleSave(); setTimeout(fitCanvas, 40);
    }));
    $("#addSlide").addEventListener("click", () => { if(state.slides>=20) return showToast("Maximum 20 slides"); pushHistory(); state.slides++; updateArtboardGeometry(); renderLayers(); scheduleSave(); fitCanvas(); });
    $("#removeSlide").addEventListener("click", () => { if(state.slides<=1) return; pushHistory(); state.slides--; state.slideBackgrounds.length=state.slides; updateArtboardGeometry(); renderLayers(); scheduleSave(); fitCanvas(); });
    $("#zoomRange").addEventListener("input", (event) => { state.zoom=Number(event.target.value); updateZoom(); });
    $("#zoomIn").addEventListener("click", () => { state.zoom=Math.min(100,state.zoom+5); updateZoom(); });
    $("#zoomOut").addEventListener("click", () => { state.zoom=Math.max(10,state.zoom-5); updateZoom(); });
    $("#fitButton").addEventListener("click", fitCanvas);
    $("#drawFrameButton").addEventListener("click", () => setFrameDrawMode(!state.frameDrawMode));
    $("#projectTitle").addEventListener("input", (event) => { state.title=event.target.value; scheduleSave(); });
    $("#undoButton").addEventListener("click", undo);
    $("#redoButton").addEventListener("click", redo);
    artboard.addEventListener("pointerdown", pointerStart);
    artboard.addEventListener("dblclick", (event) => {
      const element = event.target.closest(".image-layer,.video-layer");
      if (!element) return;
      const layer = state.layers.find((item) => item.id === element.dataset.id);
      if (!layer || layer.locked) return;
      state.selectedId = layer.id;
      state.cropModeId = state.cropModeId === layer.id ? null : layer.id;
      renderLayers();
      showToast(state.cropModeId ? "Drag the media to reposition it" : "Media position saved");
    });
    const isPhotoDrag = (event) => {
      const types = [...event.dataTransfer.types];
      return types.includes("application/x-seam-media") || types.includes("Files");
    };
    artboard.addEventListener("dragenter", (event) => {
      if (!isPhotoDrag(event)) return;
      if (state.frameDrawMode) setFrameDrawMode(false, false);
      event.preventDefault();
      event.stopPropagation();
      $("#dropOverlay").classList.remove("show");
      artboard.classList.add("media-drop-target");
    });
    artboard.addEventListener("dragover", (event) => {
      if (!isPhotoDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      $("#dropOverlay").classList.remove("show");
      artboard.classList.add("media-drop-target");
      $$(".image-layer.drop-slot,.video-layer.drop-slot", artboard).forEach((slot) => slot.classList.remove("drop-slot"));
      const slot = event.target.closest(".image-layer,.video-layer") || photoFrameAtPoint(event.clientX, event.clientY);
      if (slot) slot.classList.add("drop-slot");
    });
    artboard.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && artboard.contains(event.relatedTarget)) return;
      artboard.classList.remove("media-drop-target");
      $$(".image-layer.drop-slot,.video-layer.drop-slot", artboard).forEach((slot) => slot.classList.remove("drop-slot"));
    });
    artboard.addEventListener("drop", (event) => {
      const mediaId = event.dataTransfer.getData("application/x-seam-media");
      const mediaFiles = [...event.dataTransfer.files].filter(isSupportedMediaFile);
      if (!mediaId && !mediaFiles.length) return;
      event.preventDefault();
      event.stopPropagation();
      artboard.classList.remove("media-drop-target");
      $$(".image-layer.drop-slot,.video-layer.drop-slot", artboard).forEach((slot) => slot.classList.remove("drop-slot"));
      $("#dropOverlay").classList.remove("show");
      const slotElement = event.target.closest(".image-layer,.video-layer") || photoFrameAtPoint(event.clientX, event.clientY);
      const rect = artboard.getBoundingClientRect();
      const scaleX = rect.width / (ratioInfo().w * state.slides);
      const scaleY = rect.height / ratioInfo().h;
      const placement = {
        x: (event.clientX - rect.left) / scaleX,
        y: (event.clientY - rect.top) / scaleY,
      };
      if (mediaFiles.length) {
        handleFiles(mediaFiles, slotElement?.dataset.id || null, placement, true);
        return;
      }
      const item = state.media.find((media) => media.id === mediaId);
      if (!item) return;
      if (slotElement) {
        const layer = state.layers.find((candidate) => candidate.id === slotElement.dataset.id);
        if (layer) {
          replaceMediaInLayer(layer, item);
          return;
        }
      }
      addMediaLayer(item, placement);
      showToast(`${mediaKind(item) === "video" ? "Video" : "Photo"} added where you dropped it`);
    });
    $("#deleteLayer").addEventListener("click", deleteSelected);
    $("#closeProperties").addEventListener("click", () => { state.selectedId=null; state.cropModeId=null; renderLayers(); });
    const geometryBindings = {
      geometryX:["x", -100000], geometryY:["y", -100000], geometryW:["w", 1], geometryH:["h", 1], geometryRotation:["rotation", -3600],
    };
    Object.entries(geometryBindings).forEach(([id, [property, minimum]]) => {
      $(`#${id}`).addEventListener("change", (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return syncProperties();
        mutateSelected((layer) => { layer[property] = Math.max(minimum, value); }, true);
        syncProperties();
      });
    });
    $("#opacityRange").addEventListener("input", (event) => mutateSelected((layer) => layer.opacity=Number(event.target.value)/100));
    $("#radiusRange").addEventListener("input", (event) => mutateSelected((layer) => layer.radius=Number(event.target.value)));
    $("#imageZoomRange").addEventListener("input", (event) => mutateSelected((layer) => layer.imageScale=Number(event.target.value)/100));
    $("#imageFocusXRange").addEventListener("input", (event) => mutateSelected((layer) => layer.focusX=Number(event.target.value)));
    $("#imageFocusYRange").addEventListener("input", (event) => mutateSelected((layer) => layer.focusY=Number(event.target.value)));
    $("#repositionImage").addEventListener("click", () => {
      const layer = selectedLayer();
      if (!isVisualLayer(layer) || layer.locked) return;
      state.cropModeId = state.cropModeId === layer.id ? null : layer.id;
      renderLayers();
      showToast(state.cropModeId ? "Drag the media inside its frame" : "Media position saved");
    });
    $$('[data-fit]').forEach((button) => button.addEventListener("click", () => mutateSelected((layer) => layer.fit=button.dataset.fit, true)));
    $("#textContent").addEventListener("input", (event) => mutateSelected((layer) => layer.text=event.target.value));
    $("#fontFamily").addEventListener("change", (event) => mutateSelected((layer) => layer.fontFamily=event.target.value, true));
    $("#fontSizeRange").addEventListener("input", (event) => mutateSelected((layer) => layer.fontSize=Number(event.target.value)));
    $("#textColor").addEventListener("input", (event) => mutateSelected((layer) => layer.color=event.target.value));
    $$("#textAlign button").forEach((button) => button.addEventListener("click", () => mutateSelected((layer) => layer.align=button.dataset.align, true)));
    $("#sendBack").addEventListener("click", () => mutateSelected((layer) => layer.z=Math.min(...state.layers.map((item)=>item.z))-1, true, true));
    $("#bringFront").addEventListener("click", () => mutateSelected((layer) => layer.z=nextZ(), true, true));
    $("#duplicateLayer").addEventListener("click", duplicateSelected);
    $("#previewButton").addEventListener("click", openPreview);
    $("#mobilePreviewButton").addEventListener("click", openPreview);
    $("#exportButton").addEventListener("click", openExport);
    $("#confirmExport").addEventListener("click", exportAll);
    $("#exportQuality").addEventListener("input", (event) => $("#exportQualityValue").textContent=`${event.target.value}%`);
    $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
    $("#previewNext").addEventListener("click", () => { state.previewIndex=Math.min(state.slides-1,state.previewIndex+1); updatePreviewPosition(); });
    $("#previewPrev").addEventListener("click", () => { state.previewIndex=Math.max(0,state.previewIndex-1); updatePreviewPosition(); });
    $("#homeButton").addEventListener("click", showHome);
    $("#newGraphicButton").addEventListener("click", startNewProject);
    $("#quickCreateButton").addEventListener("click", startNewProject);

    document.addEventListener("keydown", (event) => {
      if (["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) return;
      if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); deleteSelected(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      if (event.key === "Escape" && state.frameDrawMode) { setFrameDrawMode(false); return; }
      if (event.key === "Escape") { state.selectedId=null; state.cropModeId=null; renderLayers(); $(".left-panel").classList.remove("open"); }
    });

    let dragDepth = 0;
    document.addEventListener("dragenter", (event) => {
      event.preventDefault();
      if ([...event.dataTransfer.types].some((type) => type === "application/x-seam-media" || type === "application/x-seam-layer")) return;
      dragDepth++;
      if (!artboard.contains(event.target)) $("#dropOverlay").classList.add("show");
    });
    document.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (artboard.contains(event.target)) $("#dropOverlay").classList.remove("show");
    });
    document.addEventListener("dragleave", (event) => {
      event.preventDefault();
      if ([...event.dataTransfer.types].some((type) => type === "application/x-seam-media" || type === "application/x-seam-layer")) return;
      dragDepth--;
      if(dragDepth<=0) $("#dropOverlay").classList.remove("show");
    });
    document.addEventListener("drop", (event) => {
      event.preventDefault();
      if (event.dataTransfer.getData("application/x-seam-media") || event.dataTransfer.getData("application/x-seam-layer")) return;
      dragDepth=0;
      $("#dropOverlay").classList.remove("show");
      handleFiles(event.dataTransfer.files);
    });
    window.addEventListener("resize", () => setTimeout(fitCanvas, 80));
  }

  async function init() {
    try { await loadSaved(); } catch (error) { console.error("Local database could not be opened", error); }
    bindEvents();
    syncAll();
    await showHome();
  }

  init();
})();
