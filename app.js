(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const ARTBOARD_BASE_HEIGHT = 675;
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
    cropModeId: null,
    frameDrawMode: false,
  };

  let drag = null;
  let saveTimer = null;
  let toastTimer = null;
  let persistEnabled = true;

  const artboard = $("#artboard");
  const rightPanel = $(".right-panel");

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function snapshot() {
    return JSON.stringify({
      projectId: state.projectId,
      updatedAt: state.updatedAt,
      title: state.title,
      slides: state.slides,
      ratio: state.ratio,
      background: state.background,
      slideBackgrounds: state.slideBackgrounds,
      layers: state.layers,
      media: state.media,
      activeTemplate: state.activeTemplate,
      templatePhotoCount: state.templatePhotoCount,
    });
  }

  function pushHistory() {
    state.history.push(snapshot());
    if (state.history.length > 40) state.history.shift();
    state.future = [];
    updateHistoryButtons();
  }

  function restore(serialized) {
    const data = JSON.parse(serialized);
    Object.assign(state, data, { selectedId: null });
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

  function saveProjectNow() {
    if (!persistEnabled || !state.projectId) return;
    clearTimeout(saveTimer);
    state.updatedAt = Date.now();
    try {
      const serialized = snapshot();
      localStorage.setItem(`seam-project:${state.projectId}`, serialized);
      localStorage.setItem("seam-current-project", state.projectId);
      const metadata = {
        id:state.projectId, title:state.title || "Untitled graphic", updatedAt:state.updatedAt,
        slides:state.slides, ratio:state.ratio, background:state.background,
      };
      const index = projectIndex().filter((project) => project.id !== state.projectId);
      index.unshift(metadata);
      localStorage.setItem("seam-project-index", JSON.stringify(index));
      localStorage.removeItem("seam-project");
      $("#saveStatus").textContent = "Saved locally";
    } catch {
      persistEnabled = false;
      $("#saveStatus").textContent = "Project too large to autosave";
    }
  }

  function loadSaved() {
    let currentId = localStorage.getItem("seam-current-project");
    let saved = currentId ? localStorage.getItem(`seam-project:${currentId}`) : null;
    if (!saved) saved = localStorage.getItem("seam-project");
    if (!saved) {
      currentId = projectIndex()[0]?.id || null;
      if (currentId) saved = localStorage.getItem(`seam-project:${currentId}`);
    }
    if (!saved) return false;
    try {
      const data = JSON.parse(saved);
      if (data && Array.isArray(data.layers)) {
        Object.assign(state, data);
        state.projectId ||= currentId || uid();
        state.updatedAt ||= Date.now();
        if (!Array.isArray(state.slideBackgrounds)) state.slideBackgrounds = [];
        return true;
      }
    } catch {}
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

      if (layer.type === "image") {
        const clip = document.createElement("div");
        clip.className = "image-clip";
        const image = document.createElement("img");
        image.src = layer.src;
        image.alt = "";
        image.draggable = false;
        image.style.objectFit = layer.fit || "cover";
        image.style.borderRadius = `${layer.radius || 0}px`;
        image.style.filter = layer.filter || "none";
        image.style.objectPosition = `${layer.focusX ?? 50}% ${layer.focusY ?? 50}%`;
        image.style.transformOrigin = `${layer.focusX ?? 50}% ${layer.focusY ?? 50}%`;
        image.style.transform = `scale(${layer.imageScale || 1})`;
        clip.appendChild(image);
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
      const label = layer.type === "image" ? `Photo ${ordered.filter((item) => item.type === "image").length - ordered.slice(0, index).filter((item) => item.type === "image").length}` : (layer.text || "Text").replace(/\n/g, " ");
      row.innerHTML = `
        <span class="layer-drag" title="Drag to reorder">⠿</span>
        <span class="layer-thumb">${layer.type === "image" ? `<img src="${layer.src}" alt="" />` : "Aa"}</span>
        <span class="layer-meta"><b>${escapeHtml(label)}</b><small>${layer.type === "image" ? "Photo" : "Text"}${layer.locked ? " · Locked" : ""}</small></span>
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
      if (layer.type === "image") {
        return `<span class="project-mini-layer" style="${baseStyle}"><img src="${layer.src}" alt="" style="object-position:${layer.focusX ?? 50}% ${layer.focusY ?? 50}%;transform:scale(${layer.imageScale || 1});filter:${layer.filter || "none"}" /></span>`;
      }
      return `<span class="project-mini-layer project-mini-text" style="${baseStyle}font-family:${layer.fontFamily || "sans-serif"};font-size:${Math.max(4,Math.min(18,(layer.fontSize || 20) / 5))}px;font-weight:${layer.fontWeight || 400};color:${layer.color || "#171719"};text-align:${layer.align || "left"}">${escapeHtml(layer.text || "")}</span>`;
    }).join("");
    return `<div class="project-preview-page" style="aspect-ratio:${info.w}/${info.h};background:${firstBackground}">${layerMarkup}</div>`;
  }

  function formatProjectDate(timestamp) {
    if (!timestamp) return "Saved locally";
    return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric"}).format(new Date(timestamp));
  }

  function renderProjectHome() {
    const grid = $("#projectGrid");
    const projects = projectIndex().map((metadata) => {
      try {
        const saved = localStorage.getItem(`seam-project:${metadata.id}`);
        return saved ? {...metadata, data:JSON.parse(saved)} : null;
      } catch { return null; }
    }).filter(Boolean).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    $("#projectCount").textContent = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
    if (!projects.length) {
      grid.innerHTML = '<div class="project-empty"><div><b>No graphics yet</b><span>Create your first design with the button above.</span></div></div>';
      return;
    }
    grid.innerHTML = projects.map((project) => `
      <button class="project-card" data-project-id="${project.id}" aria-label="Open ${escapeHtml(project.title || "Untitled graphic")}">
        <span class="project-card-preview">${projectPreviewMarkup(project.data)}</span>
        <span class="project-card-meta">
          <span><b>${escapeHtml(project.title || "Untitled graphic")}</b><small>${project.slides} ${project.slides === 1 ? "slide" : "slides"} · ${project.ratio} · ${formatProjectDate(project.updatedAt)}</small></span>
          <span class="project-card-arrow"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></span>
        </span>
      </button>`).join("");
    $$(".project-card", grid).forEach((card) => card.addEventListener("click", () => openProject(card.dataset.projectId)));
  }

  function showHome() {
    if (state.projectId) saveProjectNow();
    renderProjectHome();
    $("#homeScreen").classList.remove("hidden");
    [$(".topbar"), $(".workspace")].forEach((element) => { element.inert = true; element.setAttribute("aria-hidden", "true"); });
  }

  function showEditor() {
    $("#homeScreen").classList.add("hidden");
    [$(".topbar"), $(".workspace")].forEach((element) => { element.inert = false; element.removeAttribute("aria-hidden"); });
    setTimeout(fitCanvas, 60);
  }

  function openProject(projectId) {
    try {
      const data = JSON.parse(localStorage.getItem(`seam-project:${projectId}`));
      if (!data) return;
      Object.assign(state, data, {
        projectId:data.projectId || projectId,
        updatedAt:data.updatedAt || Date.now(),
        slideBackgrounds:Array.isArray(data.slideBackgrounds) ? data.slideBackgrounds : [],
        selectedId:null, history:[], future:[], previewIndex:0, cropModeId:null, frameDrawMode:false,
        backgroundStart:0, backgroundSpan:"all",
      });
      localStorage.setItem("seam-current-project", state.projectId);
      syncAll();
      showEditor();
    } catch { showToast("This project could not be opened"); }
  }

  function startNewProject() {
    clearTimeout(saveTimer);
    Object.assign(state, {
      projectId:uid(), updatedAt:Date.now(), title:"Untitled graphic", slides:1, ratio:"4:5",
      background:"#f4f1e8", slideBackgrounds:[], backgroundStart:0, backgroundSpan:"all", zoom:55,
      layers:[], media:[], selectedId:null, history:[], future:[], previewIndex:0,
      activeTemplate:"blank-single", templatePhotoCount:3, cropModeId:null, frameDrawMode:false,
    });
    persistEnabled = true;
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

  function addImage(src, naturalW = 1200, naturalH = 900, placement = null) {
    pushHistory();
    const { w, h } = ratioInfo();
    const aspect = naturalW / naturalH;
    let width = Math.min(w * 1.35, 650);
    let height = width / aspect;
    if (height > h * .85) { height = h * .85; width = height * aspect; }
    const totalWidth = w * state.slides;
    const x = placement ? Math.max(0, Math.min(totalWidth - width, placement.x - width / 2)) : Math.max(24, (totalWidth - width) / 2);
    const y = placement ? Math.max(0, Math.min(h - height, placement.y - height / 2)) : (h - height) / 2;
    const layer = {
      id: uid(), type: "image", src,
      x, y,
      w: width, h: height, z: nextZ(), opacity: 1, radius: 0, fit: "cover", rotation: 0,
      imageScale:1, focusX:50, focusY:50, hidden:false, locked:false,
    };
    state.layers.push(layer);
    state.selectedId = layer.id;
    renderLayers();
    scheduleSave();
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
    const duplicate = JSON.parse(JSON.stringify(layer));
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
    $("#layerType").textContent = layer.type === "image" ? "Photo" : "Text";
    $("#imageProperties").classList.toggle("hidden", layer.type !== "image");
    $("#textProperties").classList.toggle("hidden", layer.type !== "text");
    $("#opacityRange").value = Math.round((layer.opacity ?? 1) * 100);
    $("#opacityValue").textContent = `${$("#opacityRange").value}%`;
    if (layer.type === "image") {
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

  function mutateSelected(mutator, history = false) {
    const layer = selectedLayer();
    if (!layer) return;
    if (layer.locked) { showToast("Unlock this layer to edit it"); syncProperties(); return; }
    if (history) pushHistory();
    mutator(layer);
    renderLayers();
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
      const button = document.createElement("button");
      button.className = "media-thumb";
      button.draggable = true;
      button.title = "Drag into a photo frame or click to add";
      button.setAttribute("aria-label", "Add uploaded photo to canvas");
      button.innerHTML = `<img src="${item.src}" alt="Uploaded photo" />`;
      button.addEventListener("click", () => addImage(item.src, item.w, item.h));
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
      grid.appendChild(button);
    });
  }

  function replacePhotoInLayer(layer, item) {
    if (!layer) return false;
    if (layer.locked) { showToast("Unlock this layer to replace its photo"); return false; }
    pushHistory();
    layer.src = item.src;
    layer.fit = "cover";
    layer.imageScale = 1;
    layer.focusX = 50;
    layer.focusY = 50;
    state.selectedId = layer.id;
    state.cropModeId = null;
    renderLayers();
    scheduleSave();
    showToast("Photo placed in frame");
    return true;
  }

  function handleFiles(files, targetLayerId = null, placement = null, placeOnCanvas = false) {
    const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
    let loadedCount = 0;
    imageFiles.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = () => {
        const image = new Image();
        image.onload = () => {
          const item = { id: uid(), src: reader.result, w: image.naturalWidth, h: image.naturalHeight };
          state.media.push(item);
          renderMedia();
          const targetLayer = index === 0 && targetLayerId ? state.layers.find((layer) => layer.id === targetLayerId) : null;
          if (targetLayer) {
            replacePhotoInLayer(targetLayer, item);
          } else if (placeOnCanvas) {
            const offsetPlacement = placement ? { x:placement.x + index * 24, y:placement.y + index * 24 } : null;
            addImage(item.src, item.w, item.h, offsetPlacement);
          } else {
            scheduleSave();
          }
          loadedCount++;
          if (!targetLayer && !placeOnCanvas && loadedCount === imageFiles.length) {
            showToast(`${imageFiles.length} ${imageFiles.length === 1 ? "photo" : "photos"} added to Media`);
          }
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
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
      z:options.z ?? 1, opacity:1, radius:options.radius ?? 0, fit:"cover", rotation:options.rotation ?? 0,
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
      state.layers.push(photo(10, 10, w-20, h*.50, ["#cdd4d9", "#f1e8df"], {radius:24}));
      state.layers.push(photo(10, h*.48, w-20, h*.51, ["#9d7458", "#e7bd93"], {radius:24, z:2}));
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
      const gap=7, margin=10, cellW=(w-margin*2-gap)/2, cellH=(h-margin*2-gap)/2;
      state.layers.push(photo(margin, margin, cellW, cellH, ["#a78c6c", "#e5d2b7"], {radius:22}));
      state.layers.push(photo(margin+cellW+gap, margin, cellW, cellH, ["#e8e5dc", "#85908e"], {radius:22, z:2}));
      state.layers.push(photo(margin, margin+cellH+gap, cellW, cellH, ["#d9d9d0", "#6e6b61"], {radius:22, z:3}));
      state.layers.push(photo(margin+cellW+gap, margin+cellH+gap, cellW, cellH, ["#ddb9a7", "#7f8d72"], {radius:22, z:4}));
    } else if (name === "scrapbook") {
      state.background = "#eee4d5";
      state.layers.push(photo(-18, -12, w*.60, h*.48, ["#6d604d", "#b9a073"], {rotation:-3, radius:18, z:1}));
      state.layers.push(photo(w*.45, -20, w*.62, h*.53, ["#443b36", "#a4886d"], {rotation:4, radius:18, z:2}));
      state.layers.push(photo(-20, h*.42, w*.63, h*.51, ["#b57d3d", "#d9be91"], {rotation:3, radius:18, z:3}));
      state.layers.push(photo(w*.43, h*.46, w*.62, h*.56, ["#6e5943", "#c29678"], {rotation:-3, radius:18, z:4}));
      state.layers.push(copy("SUNDAY\nNOTES", 203, 300, 150, 80, {fontFamily:"'Instrument Serif', serif", fontSize:38, color:"#fffaf1", align:"center", rotation:-2, z:8}));
    } else if (name === "nine-mood") {
      state.background = "#f2eee5";
      const gap=6, margin=8, cellW=(w-margin*2-gap*2)/3, cellH=(h-margin*2-gap*2)/3;
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
      state.layers.push(photo(40,55,w*.82,h-110,["#a27670","#e1a8a0"],{radius:160}));
      state.layers.push(photo(w*1.1,55,w*.82,h-110,["#526c6a","#b4bbb1"],{radius:160,z:2}));
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(10,width)}" height="${Math.max(10,height)}" viewBox="0 0 800 800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><filter id="n"><feTurbulence baseFrequency=".65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .09"/></feComponentTransfer></filter></defs><rect width="800" height="800" fill="url(#g)"/><circle cx="630" cy="160" r="190" fill="rgba(255,255,255,.16)"/><path d="M0 650 Q220 400 410 590 T800 470 V800 H0Z" fill="rgba(20,30,30,.20)"/><rect width="800" height="800" filter="url(#n)" opacity=".45"/></svg>`;
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
      mode: state.cropModeId === id && layer.type === "image" ? "image-pan" : (event.target.dataset.resize ? "resize" : "move"),
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
      layer.x = drag.x + dx;
      layer.y = drag.y + dy;
    } else {
      let newW = Math.max(45, drag.w + dx);
      let newH = Math.max(35, drag.h + dy);
      if (event.shiftKey || (layer.type === "image" && !layer.userFrame)) newH = newW / drag.aspect;
      layer.w = newW;
      layer.h = newH;
    }
    const element = $(`.canvas-layer[data-id="${layer.id}"]`);
    if (element && drag.mode !== "image-pan") Object.assign(element.style, { left:`${layer.x}px`, top:`${layer.y}px`, width:`${layer.w}px`, height:`${layer.h}px` });
  }

  function pointerEnd() {
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

  async function drawLayer(ctx, layer, offsetX, scale) {
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

    if (layer.type === "image") {
      const image = await loadImage(layer.src);
      roundedRect(ctx, x, y, w, h, (layer.radius || 0) * scale);
      ctx.clip();
      ctx.filter = layer.filter || "none";
      const imageAspect = image.naturalWidth / image.naturalHeight;
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
      ctx.drawImage(image, drawX, drawY, drawW, drawH);
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
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
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
    ctx.fillStyle = backgroundColorForSlide(index);
    ctx.fillRect(0, 0, outW, outH);
    const scale = outW / info.w;
    const offset = index * info.w;
    const ordered = [...state.layers].filter((layer) => !layer.hidden).sort((a,b) => a.z-b.z);
    for (const layer of ordered) await drawLayer(ctx, layer, offset, scale);
    return canvas;
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
    $("#exportSummaryTitle").textContent = `${state.slides} high-quality ${state.slides === 1 ? "slide" : "slides"}`;
    $("#exportStack").innerHTML = Array.from({length:Math.min(state.slides,4)}, (_,i) => `<i style="--rotate:${(i-(state.slides-1)/2)*5}deg"></i>`).join("");
    $("#exportDialog").showModal();
  }

  async function exportAll() {
    const button = $("#confirmExport");
    const original = button.innerHTML;
    const format = $("#exportFormat").value;
    const quality = Number($("#exportQuality").value) / 100;
    button.disabled = true;
    for (let i = 0; i < state.slides; i++) {
      button.querySelector("span").textContent = `Rendering ${i+1} of ${state.slides}…`;
      const canvas = await renderSlide(i);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, `image/${format}`, quality));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const safeTitle = state.title.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,"") || "carousel";
      anchor.href = url;
      anchor.download = `${safeTitle}-${String(i+1).padStart(2,"0")}.${format === "jpeg" ? "jpg" : "png"}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    button.innerHTML = original;
    button.disabled = false;
    $("#exportDialog").close();
    showToast(`${state.slides} ${state.slides === 1 ? "slide" : "slides"} exported in posting order`);
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function photoFrameAtPoint(clientX, clientY) {
    return [...artboard.querySelectorAll(".canvas-layer.image-layer")].reverse().find((element) => {
      const rect = element.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }) || null;
  }

  function bindEvents() {
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
      const element = event.target.closest(".image-layer");
      if (!element) return;
      const layer = state.layers.find((item) => item.id === element.dataset.id);
      if (!layer || layer.locked) return;
      state.selectedId = layer.id;
      state.cropModeId = state.cropModeId === layer.id ? null : layer.id;
      renderLayers();
      showToast(state.cropModeId ? "Drag the photo to reposition it" : "Photo position saved");
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
      $$(".image-layer.drop-slot", artboard).forEach((slot) => slot.classList.remove("drop-slot"));
      const slot = event.target.closest(".image-layer") || photoFrameAtPoint(event.clientX, event.clientY);
      if (slot) slot.classList.add("drop-slot");
    });
    artboard.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && artboard.contains(event.relatedTarget)) return;
      artboard.classList.remove("media-drop-target");
      $$(".image-layer.drop-slot", artboard).forEach((slot) => slot.classList.remove("drop-slot"));
    });
    artboard.addEventListener("drop", (event) => {
      const mediaId = event.dataTransfer.getData("application/x-seam-media");
      const imageFiles = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
      if (!mediaId && !imageFiles.length) return;
      event.preventDefault();
      event.stopPropagation();
      artboard.classList.remove("media-drop-target");
      $$(".image-layer.drop-slot", artboard).forEach((slot) => slot.classList.remove("drop-slot"));
      $("#dropOverlay").classList.remove("show");
      const slotElement = event.target.closest(".image-layer") || photoFrameAtPoint(event.clientX, event.clientY);
      const rect = artboard.getBoundingClientRect();
      const scaleX = rect.width / (ratioInfo().w * state.slides);
      const scaleY = rect.height / ratioInfo().h;
      const placement = {
        x: (event.clientX - rect.left) / scaleX,
        y: (event.clientY - rect.top) / scaleY,
      };
      if (imageFiles.length) {
        handleFiles(imageFiles, slotElement?.dataset.id || null, placement, true);
        return;
      }
      const item = state.media.find((media) => media.id === mediaId);
      if (!item) return;
      if (slotElement) {
        const layer = state.layers.find((candidate) => candidate.id === slotElement.dataset.id);
        if (layer) {
          replacePhotoInLayer(layer, item);
          return;
        }
      }
      addImage(item.src, item.w, item.h, placement);
      showToast("Photo added where you dropped it");
    });
    $("#deleteLayer").addEventListener("click", deleteSelected);
    $("#closeProperties").addEventListener("click", () => { state.selectedId=null; state.cropModeId=null; renderLayers(); });
    $("#opacityRange").addEventListener("input", (event) => mutateSelected((layer) => layer.opacity=Number(event.target.value)/100));
    $("#radiusRange").addEventListener("input", (event) => mutateSelected((layer) => layer.radius=Number(event.target.value)));
    $("#imageZoomRange").addEventListener("input", (event) => mutateSelected((layer) => layer.imageScale=Number(event.target.value)/100));
    $("#imageFocusXRange").addEventListener("input", (event) => mutateSelected((layer) => layer.focusX=Number(event.target.value)));
    $("#imageFocusYRange").addEventListener("input", (event) => mutateSelected((layer) => layer.focusY=Number(event.target.value)));
    $("#repositionImage").addEventListener("click", () => {
      const layer = selectedLayer();
      if (!layer || layer.type !== "image" || layer.locked) return;
      state.cropModeId = state.cropModeId === layer.id ? null : layer.id;
      renderLayers();
      showToast(state.cropModeId ? "Drag the photo inside its frame" : "Photo position saved");
    });
    $$('[data-fit]').forEach((button) => button.addEventListener("click", () => mutateSelected((layer) => layer.fit=button.dataset.fit, true)));
    $("#textContent").addEventListener("input", (event) => mutateSelected((layer) => layer.text=event.target.value));
    $("#fontFamily").addEventListener("change", (event) => mutateSelected((layer) => layer.fontFamily=event.target.value, true));
    $("#fontSizeRange").addEventListener("input", (event) => mutateSelected((layer) => layer.fontSize=Number(event.target.value)));
    $("#textColor").addEventListener("input", (event) => mutateSelected((layer) => layer.color=event.target.value));
    $$("#textAlign button").forEach((button) => button.addEventListener("click", () => mutateSelected((layer) => layer.align=button.dataset.align, true)));
    $("#sendBack").addEventListener("click", () => mutateSelected((layer) => layer.z=Math.min(...state.layers.map((item)=>item.z))-1, true));
    $("#bringFront").addEventListener("click", () => mutateSelected((layer) => layer.z=nextZ(), true));
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

  function init() {
    loadSaved();
    bindEvents();
    syncAll();
    showHome();
  }

  init();
})();
