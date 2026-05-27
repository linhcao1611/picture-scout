/* ═══════════════════════════════════════════════════════════════
   Picture Scout — Client-side Application Logic
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── State ─────────────────────────────────────────────────── */
  const state = {
    images: [],               // { path, filename, size, date, score, analysis }
    filteredImages: [],       // post-sort/filter view
    currentFolder: '',
    sortBy: 'score-desc',
    minScore: 0,
    topPicksOnly: false,
    analyzing: false,
    selectedIndex: -1,        // index in filteredImages
    settings: {
      provider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      lmStudioUrl: 'http://localhost:1234/v1',
      model: 'moondream:latest',
      thumbnailSize: 300,
    },
    availableModels: [],      // available models from Ollama
  };

  const TOP_PICK_THRESHOLD = 8.0;

  /* ── DOM refs ──────────────────────────────────────────────── */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    connectionStatus: $('#connection-status'),
    statusLabel: $('#connection-status .status-label'),
    settingsBtn: $('#settings-btn'),
    folderInput: $('#folder-input'),
    scanBtn: $('#scan-btn'),
    analyzeAllBtn: $('#analyze-all-btn'),
    clearCacheBtn: $('#clear-cache-btn'),
    toolbar: $('#toolbar'),
    sortSelect: $('#sort-select'),
    minScoreSlider: $('#min-score-slider'),
    minScoreValue: $('#min-score-value'),
    topPicksToggle: $('#top-picks-toggle'),
    resultCount: $('#result-count'),
    progressSection: $('#progress-section'),
    progressLabel: $('#progress-label'),
    progressPercent: $('#progress-percent'),
    progressBarFill: $('#progress-bar-fill'),
    progressStatus: $('#progress-status'),
    gallery: $('#gallery'),
    emptyState: $('#empty-state'),
    detailPanel: $('#detail-panel'),
    detailBackdrop: $('#detail-backdrop'),
    detailCloseBtn: $('#detail-close-btn'),
    detailFilename: $('#detail-filename'),
    detailImage: $('#detail-image'),
    detailSize: $('#detail-size'),
    detailDimensions: $('#detail-dimensions'),
    detailDate: $('#detail-date'),
    detailStars: $('#detail-stars'),
    detailScoreValue: $('#detail-score-value'),
    detailScoreSection: $('#detail-score-section'),
    detailBreakdown: $('#detail-breakdown'),
    detailFeedback: $('#detail-feedback'),
    detailFeedbackSection: $('#detail-feedback-section'),
    detailTags: $('#detail-tags'),
    detailTagsSection: $('#detail-tags-section'),
    detailPrevBtn: $('#detail-prev-btn'),
    detailNextBtn: $('#detail-next-btn'),
    settingsModal: $('#settings-modal'),
    settingsCloseBtn: $('#settings-close-btn'),
    settingsCancelBtn: $('#settings-cancel-btn'),
    settingsSaveBtn: $('#settings-save-btn'),
    settingProvider: $('#setting-provider'),
    settingOllamaUrl: $('#setting-ollama-url'),
    settingLmStudioUrl: $('#setting-lmstudio-url'),
    settingOllamaUrlContainer: $('#setting-ollama-url-container'),
    settingLmStudioUrlContainer: $('#setting-lmstudio-url-container'),
    settingModelLabel: $('#setting-model-label'),
    settingModelHint: $('#setting-model-hint'),
    settingModel: $('#setting-model'),
    settingModelCustom: $('#setting-model-custom'),
    settingModelCustomContainer: $('#setting-model-custom-container'),
    settingThumbSize: $('#setting-thumb-size'),
    toastContainer: $('#toast-container'),
  };


  /* ═══════════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════════ */
  function init() {
    loadSettings();
    bindEvents();
    checkConnection();
    // Periodically check connection every 30 s
    setInterval(checkConnection, 30000);
  }

  function bindEvents() {
    dom.scanBtn.addEventListener('click', scanFolder);
    dom.folderInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') scanFolder();
    });
    dom.analyzeAllBtn.addEventListener('click', analyzeAll);
    dom.clearCacheBtn.addEventListener('click', clearCache);

    dom.sortSelect.addEventListener('change', () => updateSort(dom.sortSelect.value));
    dom.minScoreSlider.addEventListener('input', () => {
      const v = parseFloat(dom.minScoreSlider.value);
      dom.minScoreValue.textContent = v;
      updateFilter(v);
    });
    dom.topPicksToggle.addEventListener('change', toggleTopPicks);

    dom.settingsBtn.addEventListener('click', showSettings);
    dom.settingsCloseBtn.addEventListener('click', hideSettings);
    dom.settingsCancelBtn.addEventListener('click', hideSettings);
    dom.settingsSaveBtn.addEventListener('click', saveSettings);
    dom.settingProvider.addEventListener('change', () => {
      syncProviderFields(dom.settingProvider.value);
      checkConnectionForProvider(dom.settingProvider.value);
    });
    dom.settingModel.addEventListener('change', () => {
      if (dom.settingModel.value === '__custom__') {
        dom.settingModelCustomContainer.classList.remove('hidden');
        dom.settingModelCustom.focus();
      } else {
        dom.settingModelCustomContainer.classList.add('hidden');
      }
    });

    dom.detailCloseBtn.addEventListener('click', hideDetail);
    dom.detailBackdrop.addEventListener('click', hideDetail);
    dom.detailPrevBtn.addEventListener('click', () => navigateDetail(-1));
    dom.detailNextBtn.addEventListener('click', () => navigateDetail(1));

    document.addEventListener('keydown', handleKeyboard);
  }


  /* ═══════════════════════════════════════════════════════════
     CONNECTION CHECK
     ═══════════════════════════════════════════════════════════ */
  async function checkConnection() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('bad status');
      const data = await res.json();
      
      // Update state settings
      state.settings.provider = data.provider || 'ollama';
      state.settings.ollamaUrl = data.ollamaUrl || 'http://localhost:11434';
      state.settings.lmStudioUrl = data.lmStudioUrl || 'http://localhost:1234/v1';
      state.settings.model = data.model || 'moondream:latest';
      state.settings.thumbnailSize = data.thumbnailSize || 300;

      const providerLabel = state.settings.provider === 'lmstudio' ? 'LM Studio' : 'Ollama';

      if (data.ollamaOnline) {
        dom.connectionStatus.className = 'connection-status online';
        dom.statusLabel.textContent = `${providerLabel} Online`;
        
        // Sync models
        state.availableModels = data.availableModels || [];
      } else {
        dom.connectionStatus.className = 'connection-status offline';
        dom.statusLabel.textContent = `${providerLabel} Offline`;
        state.availableModels = [];
      }
    } catch {
      dom.connectionStatus.className = 'connection-status offline';
      dom.statusLabel.textContent = 'Offline';
      state.availableModels = [];
    }
  }

  // Sync settings UI fields based on provider value
  function syncProviderFields(provider) {
    if (provider === 'lmstudio') {
      dom.settingOllamaUrlContainer.classList.add('hidden');
      dom.settingLmStudioUrlContainer.classList.remove('hidden');
      dom.settingModelLabel.textContent = 'LM Studio Model';
      dom.settingModelHint.textContent = 'The active/loaded vision model in LM Studio.';
    } else {
      dom.settingOllamaUrlContainer.classList.remove('hidden');
      dom.settingLmStudioUrlContainer.classList.add('hidden');
      dom.settingModelLabel.textContent = 'Ollama Model';
      dom.settingModelHint.textContent = 'The vision model in Ollama to use for analysis.';
    }
  }

  // Check connection dynamically when provider changes in Settings Modal
  async function checkConnectionForProvider(provider) {
    const tempSettings = {
      ...state.settings,
      provider: provider,
      ollamaUrl: dom.settingOllamaUrl.value.trim(),
      lmStudioUrl: dom.settingLmStudioUrl.value.trim(),
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tempSettings),
      });
      if (res.ok) {
        await checkConnection();
        renderModelSelectOptions();
      }
    } catch { /* silent */ }
  }

  // Render options in model select field
  function renderModelSelectOptions() {
    dom.settingModel.innerHTML = '';
    
    const models = state.availableModels || [];
    models.forEach(modelName => {
      const opt = document.createElement('option');
      opt.value = modelName;
      opt.textContent = modelName;
      dom.settingModel.appendChild(opt);
    });

    if (state.settings.model && !models.includes(state.settings.model)) {
      const opt = document.createElement('option');
      opt.value = state.settings.model;
      opt.textContent = `${state.settings.model} (Active)`;
      dom.settingModel.insertBefore(opt, dom.settingModel.firstChild);
    }

    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom model...';
    dom.settingModel.appendChild(customOpt);

    dom.settingModel.value = state.settings.model;
    
    if (dom.settingModel.value === '__custom__' || dom.settingModel.selectedIndex === -1) {
      dom.settingModel.value = '__custom__';
      dom.settingModelCustom.value = state.settings.model;
      dom.settingModelCustomContainer.classList.remove('hidden');
    } else {
      dom.settingModelCustom.value = '';
      dom.settingModelCustomContainer.classList.add('hidden');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     SCAN FOLDER
     ═══════════════════════════════════════════════════════════ */
  async function scanFolder() {
    const folder = dom.folderInput.value.trim();
    if (!folder) {
      showToast('Please enter a folder path.', 'error');
      dom.folderInput.focus();
      return;
    }

    dom.scanBtn.disabled = true;
    dom.scanBtn.textContent = 'Scanning…';

    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Scan failed' }));
        throw new Error(err.error || 'Scan failed');
      }

      const data = await res.json();
      state.currentFolder = folder;
      state.images = (data.images || []).map((img) => ({
        path: img.path,
        filename: img.filename || img.path.split('/').pop(),
        size: img.size || 0,
        date: img.modified || img.date || '',
        dimensions: img.dimensions || '',
        score: img.analysis?.score ?? img.score ?? null,
        analysis: img.analysis || null,
      }));

      dom.analyzeAllBtn.disabled = state.images.length === 0;
      dom.clearCacheBtn.disabled = state.images.length === 0;
      dom.toolbar.classList.remove('hidden');

      applyFiltersAndRender();

      if (state.images.length === 0) {
        showToast('No images found in this folder.', 'info');
      } else {
        showToast(`Found ${state.images.length} image${state.images.length > 1 ? 's' : ''}.`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      dom.scanBtn.disabled = false;
      dom.scanBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan`;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     ANALYZE SINGLE IMAGE
     ═══════════════════════════════════════════════════════════ */
  async function analyzeImage(imagePath) {
    const card = dom.gallery.querySelector(`.image-card[data-path="${CSS.escape(imagePath)}"]`);
    if (card) card.classList.add('analyzing');

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: imagePath }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Analysis failed' }));
        throw new Error(err.error || 'Analysis failed');
      }

      const result = await res.json();
      updateImageData(imagePath, result);

      if (card) {
        card.classList.remove('analyzing');
        refreshCardContent(card, findImage(imagePath));
      }

      // If detail panel is showing this image, update it
      if (state.selectedIndex >= 0) {
        const sel = state.filteredImages[state.selectedIndex];
        if (sel && sel.path === imagePath) {
          populateDetail(sel);
        }
      }

      showToast('Analysis complete.', 'success');
    } catch (err) {
      if (card) card.classList.remove('analyzing');
      showToast(err.message, 'error');
    }
  }


  /* ═══════════════════════════════════════════════════════════
     ANALYZE ALL (SSE)
     ═══════════════════════════════════════════════════════════ */
  function analyzeAll() {
    if (state.analyzing) return;
    const folder = state.currentFolder;
    if (!folder || state.images.length === 0) return;

    state.analyzing = true;
    dom.analyzeAllBtn.disabled = true;
    showProgress();

    const url = `/api/analyze-all?folder=${encodeURIComponent(folder)}`;
    const evtSource = new EventSource(url);

    evtSource.onmessage = (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }

      if (data.type === 'progress') {
        updateProgress(data);
      }

      if (data.type === 'result') {
        updateImageData(data.path, data);
        updateProgress(data);
        const card = dom.gallery.querySelector(`.image-card[data-path="${CSS.escape(data.path)}"]`);
        if (card) {
          card.classList.remove('analyzing');
          refreshCardContent(card, findImage(data.path));
        }
        // Update detail if viewing this image
        if (state.selectedIndex >= 0) {
          const sel = state.filteredImages[state.selectedIndex];
          if (sel && sel.path === data.path) populateDetail(sel);
        }
      }

      if (data.type === 'error') {
        showToast(data.message || 'Analysis error', 'error');
      }

      if (data.type === 'done') {
        evtSource.close();
        finishAnalysis();
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      if (state.analyzing) {
        finishAnalysis();
        showToast('Analysis stream failed. Is Ollama running?', 'error');
      }
    };
  }

  function finishAnalysis() {
    state.analyzing = false;
    dom.analyzeAllBtn.disabled = false;
    hideProgress();
    applyFiltersAndRender();
    showToast('Batch analysis complete!', 'success');
  }

  async function clearCache() {
    const folder = state.currentFolder;
    if (!folder) return;

    if (!confirm('Are you sure you want to clear all curation results and cache for this folder? This cannot be undone.')) {
      return;
    }

    dom.clearCacheBtn.disabled = true;
    dom.clearCacheBtn.textContent = 'Clearing…';

    try {
      const res = await fetch(`/api/cache?folder=${encodeURIComponent(folder)}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Failed to clear cache');
      }

      showToast('Cache cleared successfully. Reloading folder...', 'success');

      // Clear local scores and analysis state
      state.images.forEach(img => {
        img.score = null;
        img.analysis = null;
      });

      applyFiltersAndRender();
      await scanFolder();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      dom.clearCacheBtn.disabled = false;
      dom.clearCacheBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        Reset Cache
      `;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     DATA HELPERS
     ═══════════════════════════════════════════════════════════ */
  function findImage(path) {
    return state.images.find((i) => i.path === path);
  }

  function updateImageData(path, result) {
    const img = findImage(path);
    if (!img) return;
    // SSE results and single-analyze results both nest under `analysis`
    const a = result.analysis || result;
    img.score = a.score ?? result.score ?? null;
    img.analysis = {
      composition: a.composition ?? null,
      lighting: a.lighting ?? null,
      color: a.color ?? null,
      sharpness: a.sharpness ?? null,
      feedback: a.feedback ?? '',
      tags: a.tags ?? [],
    };
  }


  /* ═══════════════════════════════════════════════════════════
     SORTING & FILTERING
     ═══════════════════════════════════════════════════════════ */
  function updateSort(sortBy) {
    state.sortBy = sortBy;
    applyFiltersAndRender();
  }

  function updateFilter(minScore) {
    state.minScore = minScore;
    applyFiltersAndRender();
  }

  function toggleTopPicks() {
    state.topPicksOnly = dom.topPicksToggle.checked;
    applyFiltersAndRender();
  }

  function applyFiltersAndRender() {
    let imgs = [...state.images];

    // Filter by min score
    if (state.minScore > 0) {
      imgs = imgs.filter((i) => (i.score ?? 0) >= state.minScore);
    }

    // Filter top picks
    if (state.topPicksOnly) {
      imgs = imgs.filter((i) => (i.score ?? 0) >= TOP_PICK_THRESHOLD);
    }

    // Sort
    switch (state.sortBy) {
      case 'score-desc':
        imgs.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        break;
      case 'score-asc':
        imgs.sort((a, b) => (a.score ?? 999) - (b.score ?? 999));
        break;
      case 'date':
        imgs.sort((a, b) => {
          if (!a.date && !b.date) return 0;
          if (!a.date) return 1;
          if (!b.date) return -1;
          return new Date(b.date) - new Date(a.date);
        });
        break;
      case 'name':
        imgs.sort((a, b) => a.filename.localeCompare(b.filename));
        break;
    }

    state.filteredImages = imgs;
    renderGrid();
    updateResultCount();
  }

  function updateResultCount() {
    const total = state.images.length;
    const shown = state.filteredImages.length;
    if (total === shown) {
      dom.resultCount.textContent = `${total} image${total !== 1 ? 's' : ''}`;
    } else {
      dom.resultCount.textContent = `${shown} of ${total} images`;
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RENDER GRID
     ═══════════════════════════════════════════════════════════ */
  function renderGrid() {
    dom.gallery.innerHTML = '';

    if (state.filteredImages.length === 0) {
      dom.emptyState.classList.remove('hidden');
      return;
    }

    dom.emptyState.classList.add('hidden');

    const fragment = document.createDocumentFragment();
    state.filteredImages.forEach((img, idx) => {
      fragment.appendChild(renderCard(img, idx));
    });
    dom.gallery.appendChild(fragment);

    observeLazyImages();
  }

  function renderCard(image, index) {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.path = image.path;
    card.dataset.score = image.score ?? '';
    card.style.animationDelay = `${Math.min(index * 0.04, 0.8)}s`;

    const hasScore = image.score !== null && image.score !== undefined;
    const isTopPick = hasScore && image.score >= TOP_PICK_THRESHOLD;

    card.innerHTML = `
      <div class="image-wrapper">
        <img data-src="${thumbnailUrl(image.path, image.date)}" alt="${escapeHtml(image.filename)}" loading="lazy" />
        ${isTopPick ? '<div class="top-pick-badge">★ Top Pick</div>' : ''}
        <div class="card-overlay">
          <button class="analyze-btn" data-path="${escapeAttr(image.path)}">Analyze</button>
        </div>
      </div>
      <div class="card-info">
        <span class="card-filename" title="${escapeAttr(image.filename)}">${escapeHtml(image.filename)}</span>
        <div class="card-score ${hasScore ? '' : 'unscored'}">
          <div class="stars">${renderStars(image.score)}</div>
          <span class="score-value">${hasScore ? image.score.toFixed(1) : '—'}</span>
        </div>
      </div>
    `;

    // Click card → detail
    card.addEventListener('click', (e) => {
      if (e.target.closest('.analyze-btn')) return;
      state.selectedIndex = index;
      showDetail(image);
    });

    // Analyze button
    const analyzeBtn = card.querySelector('.analyze-btn');
    analyzeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      analyzeImage(image.path);
    });

    return card;
  }

  function refreshCardContent(card, image) {
    if (!card || !image) return;
    const hasScore = image.score !== null && image.score !== undefined;
    const isTopPick = hasScore && image.score >= TOP_PICK_THRESHOLD;

    // Update score
    const scoreEl = card.querySelector('.card-score');
    if (scoreEl) {
      scoreEl.classList.toggle('unscored', !hasScore);
      scoreEl.querySelector('.stars').innerHTML = renderStars(image.score);
      scoreEl.querySelector('.score-value').textContent = hasScore ? image.score.toFixed(1) : '—';
    }

    // Update top pick badge
    let badge = card.querySelector('.top-pick-badge');
    if (isTopPick && !badge) {
      badge = document.createElement('div');
      badge.className = 'top-pick-badge';
      badge.textContent = '★ Top Pick';
      card.querySelector('.image-wrapper').appendChild(badge);
    } else if (!isTopPick && badge) {
      badge.remove();
    }

    card.dataset.score = image.score ?? '';
  }


  /* ═══════════════════════════════════════════════════════════
     LAZY LOADING via IntersectionObserver
     ═══════════════════════════════════════════════════════════ */
  let lazyObserver = null;

  function observeLazyImages() {
    if (lazyObserver) lazyObserver.disconnect();

    lazyObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const img = entry.target;
            if (img.dataset.src) {
              img.src = img.dataset.src;
              img.removeAttribute('data-src');
            }
            lazyObserver.unobserve(img);
          }
        });
      },
      { rootMargin: '200px' }
    );

    dom.gallery.querySelectorAll('img[data-src]').forEach((img) => {
      lazyObserver.observe(img);
    });
  }


  /* ═══════════════════════════════════════════════════════════
     DETAIL PANEL
     ═══════════════════════════════════════════════════════════ */
  function showDetail(image) {
    dom.detailPanel.classList.remove('hidden');
    dom.detailPanel.classList.add('visible');
    document.body.style.overflow = 'hidden';
    populateDetail(image);
  }

  function hideDetail() {
    dom.detailPanel.classList.add('hidden');
    dom.detailPanel.classList.remove('visible');
    document.body.style.overflow = '';
    state.selectedIndex = -1;
  }

  function populateDetail(image) {
    dom.detailFilename.textContent = image.filename;
    dom.detailImage.src = fullImageUrl(image.path, image.date);
    dom.detailImage.alt = image.filename;

    // Meta
    dom.detailSize.textContent = image.size ? formatFileSize(image.size) : '—';
    dom.detailDimensions.textContent = image.dimensions || '—';
    dom.detailDate.textContent = image.date ? formatDate(image.date) : '—';

    const hasScore = image.score !== null && image.score !== undefined;
    const analysis = image.analysis;

    // Score section
    if (hasScore) {
      dom.detailStars.innerHTML = renderStarsLarge(image.score);
      dom.detailScoreValue.textContent = image.score.toFixed(1);
      dom.detailScoreSection.classList.remove('hidden');
    } else {
      dom.detailStars.innerHTML = renderStarsLarge(0);
      dom.detailScoreValue.textContent = '—';
      dom.detailScoreSection.classList.remove('hidden');
    }

    // Breakdown
    dom.detailBreakdown.innerHTML = '';
    if (analysis) {
      const categories = [
        { label: 'Composition', value: analysis.composition },
        { label: 'Lighting', value: analysis.lighting },
        { label: 'Color', value: analysis.color },
        { label: 'Sharpness', value: analysis.sharpness },
      ];
      categories.forEach((cat) => {
        if (cat.value !== null && cat.value !== undefined) {
          dom.detailBreakdown.appendChild(renderScoreBar(cat.label, cat.value));
        }
      });
    }

    // Feedback
    if (analysis && analysis.feedback) {
      dom.detailFeedback.textContent = analysis.feedback;
    } else {
      dom.detailFeedback.textContent = 'No analysis yet. Click "Analyze" on the image card.';
    }

    // Tags
    dom.detailTags.innerHTML = '';
    if (analysis && analysis.tags && analysis.tags.length > 0) {
      analysis.tags.forEach((tag) => {
        const pill = document.createElement('span');
        pill.className = 'tag-pill';
        pill.textContent = tag;
        dom.detailTags.appendChild(pill);
      });
      dom.detailTagsSection.classList.remove('hidden');
    } else {
      dom.detailTagsSection.classList.remove('hidden');
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = 'No tags';
      pill.style.opacity = '0.5';
      dom.detailTags.appendChild(pill);
    }

    // Nav buttons state
    dom.detailPrevBtn.disabled = state.selectedIndex <= 0;
    dom.detailNextBtn.disabled = state.selectedIndex >= state.filteredImages.length - 1;
  }

  function navigateDetail(direction) {
    const newIdx = state.selectedIndex + direction;
    if (newIdx < 0 || newIdx >= state.filteredImages.length) return;
    state.selectedIndex = newIdx;
    populateDetail(state.filteredImages[newIdx]);
  }


  /* ═══════════════════════════════════════════════════════════
     PROGRESS
     ═══════════════════════════════════════════════════════════ */
  function showProgress() {
    dom.progressSection.classList.remove('hidden');
    dom.progressBarFill.style.width = '0%';
    dom.progressPercent.textContent = '0%';
    dom.progressLabel.textContent = 'Analyzing images…';
    dom.progressStatus.textContent = 'Preparing…';

    // Mark all cards as analyzing
    dom.gallery.querySelectorAll('.image-card').forEach((card) => {
      const img = findImage(card.dataset.path);
      if (img && img.score === null) card.classList.add('analyzing');
    });
  }

  function hideProgress() {
    dom.progressSection.classList.add('hidden');
    dom.gallery.querySelectorAll('.image-card.analyzing').forEach((c) => c.classList.remove('analyzing'));
  }

  function updateProgress(data) {
    const current = data.progress ?? data.current ?? 0;
    const total = data.total || state.images.length;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    dom.progressBarFill.style.width = `${pct}%`;
    dom.progressPercent.textContent = `${pct}%`;
    dom.progressStatus.textContent = data.filename
      ? `Analyzing ${data.filename}… (${current + 1} of ${total})`
      : `Processing ${current} of ${total}…`;
    dom.progressLabel.textContent = 'Analyzing images…';
  }


  /* ═══════════════════════════════════════════════════════════
     SETTINGS
     ═══════════════════════════════════════════════════════════ */
  function showSettings() {
    dom.settingProvider.value = state.settings.provider || 'ollama';
    dom.settingOllamaUrl.value = state.settings.ollamaUrl || 'http://localhost:11434';
    dom.settingLmStudioUrl.value = state.settings.lmStudioUrl || 'http://localhost:1234/v1';

    syncProviderFields(dom.settingProvider.value);
    renderModelSelectOptions();

    dom.settingThumbSize.value = state.settings.thumbnailSize;
    dom.settingsModal.classList.remove('hidden');
  }

  function hideSettings() {
    dom.settingsModal.classList.add('hidden');
  }

  function saveSettings() {
    let chosenModel = dom.settingModel.value;
    if (chosenModel === '__custom__') {
      chosenModel = dom.settingModelCustom.value.trim();
    }
    
    state.settings.provider = dom.settingProvider.value;
    state.settings.ollamaUrl = dom.settingOllamaUrl.value.trim() || 'http://localhost:11434';
    state.settings.lmStudioUrl = dom.settingLmStudioUrl.value.trim() || 'http://localhost:1234/v1';
    state.settings.model = chosenModel || 'moondream:latest';
    state.settings.thumbnailSize = parseInt(dom.settingThumbSize.value, 10) || 300;

    try {
      localStorage.setItem('picture-scout-settings', JSON.stringify(state.settings));
    } catch { /* ignore */ }

    hideSettings();
    showToast('Settings saved.', 'success');

    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.settings),
    })
    .then(() => {
      checkConnection();
    })
    .catch(() => { /* silent */ });
  }

  function loadSettings() {
    try {
      const saved = localStorage.getItem('picture-scout-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        state.settings = { ...state.settings, ...parsed };
      }
    } catch { /* ignore */ }
  }


  /* ═══════════════════════════════════════════════════════════
     KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════ */
  function handleKeyboard(e) {
    // Escape: close panels
    if (e.key === 'Escape') {
      if (!dom.settingsModal.classList.contains('hidden')) {
        hideSettings();
        return;
      }
      if (!dom.detailPanel.classList.contains('hidden')) {
        hideDetail();
        return;
      }
    }

    // Arrow navigation in detail
    if (!dom.detailPanel.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateDetail(-1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateDetail(1);
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════
     RENDER HELPERS
     ═══════════════════════════════════════════════════════════ */

  /** Render 5-star HTML from a 1-10 score. */
  function renderStars(score) {
    if (score === null || score === undefined) {
      return Array(5).fill('<span class="star">★</span>').join('');
    }
    const fiveScale = score / 2; // convert 10 → 5
    let html = '';
    for (let i = 1; i <= 5; i++) {
      if (fiveScale >= i) {
        html += '<span class="star filled">★</span>';
      } else if (fiveScale >= i - 0.5) {
        html += '<span class="star half">★</span>';
      } else {
        html += '<span class="star">★</span>';
      }
    }
    return html;
  }

  /** Larger stars for the detail panel. */
  function renderStarsLarge(score) {
    if (score === null || score === undefined) score = 0;
    const fiveScale = score / 2;
    let html = '';
    for (let i = 1; i <= 5; i++) {
      if (fiveScale >= i) {
        html += '<span class="star filled">★</span>';
      } else if (fiveScale >= i - 0.5) {
        html += '<span class="star half">★</span>';
      } else {
        html += '<span class="star">★</span>';
      }
    }
    return html;
  }

  /** Render a score breakdown bar DOM element. */
  function renderScoreBar(label, score) {
    const row = document.createElement('div');
    row.className = 'score-bar-row';

    let colorClass = 'score-mid';
    if (score >= 7) colorClass = 'score-high';
    else if (score < 4) colorClass = 'score-low';

    row.innerHTML = `
      <span class="score-bar-label">${escapeHtml(label)}</span>
      <div class="score-bar-track">
        <div class="score-bar-fill ${colorClass}" style="width: ${score * 10}%"></div>
      </div>
      <span class="score-bar-value">${score.toFixed(1)}</span>
    `;
    return row;
  }


  /* ═══════════════════════════════════════════════════════════
     TOAST NOTIFICATIONS
     ═══════════════════════════════════════════════════════════ */
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✓';
    if (type === 'error') icon = '✕';

    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 3500);
  }


  /* ═══════════════════════════════════════════════════════════
     UTILITY FUNCTIONS
     ═══════════════════════════════════════════════════════════ */
  function thumbnailUrl(path, modified) {
    let url = `/api/images?path=${encodeURIComponent(path)}&thumb=1`;
    if (modified) {
      url += `&t=${encodeURIComponent(modified)}`;
    }
    return url;
  }

  function fullImageUrl(path, modified) {
    let url = `/api/images?path=${encodeURIComponent(path)}`;
    if (modified) {
      url += `&t=${encodeURIComponent(modified)}`;
    }
    return url;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }


  /* ═══════════════════════════════════════════════════════════
     BOOT
     ═══════════════════════════════════════════════════════════ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
