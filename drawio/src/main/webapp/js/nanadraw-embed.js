(function() {
  if (!window.urlParams || window.urlParams.embed !== '1') return;

  var DEFAULT_LIBS = 'general;uml;er;bpmn;flowchart;basic;arrows2';

  // Reset localStorage for subsequent page loads
  try {
    var settingsKey = '.drawio-config';
    var raw = localStorage.getItem(settingsKey);
    if (raw) {
      var cfg = JSON.parse(raw);
      if (!cfg.libraries || cfg.libraries !== DEFAULT_LIBS) {
        cfg.libraries = DEFAULT_LIBS;
        localStorage.setItem(settingsKey, JSON.stringify(cfg));
      }
    }
  } catch(e) {}

  // Patch in-memory mxSettings
  if (typeof mxSettings !== 'undefined' && mxSettings.settings) {
    mxSettings.settings.libraries = DEFAULT_LIBS;
  }

  // Lock setLibraries
  if (typeof mxSettings !== 'undefined') {
    mxSettings.setLibraries = function() {
      mxSettings.settings.libraries = DEFAULT_LIBS;
    };
  }

  // Notify parent window when the user switches pages
  if (typeof EditorUi !== 'undefined') {
    var _origSelectPage = EditorUi.prototype.selectPage;
    EditorUi.prototype.selectPage = function(page, quiet, viewState) {
      var result = _origSelectPage.apply(this, arguments);
      if (this.pages && page) {
        var idx = -1;
        for (var i = 0; i < this.pages.length; i++) {
          if (this.pages[i] === page) { idx = i; break; }
        }
        if (idx >= 0) {
          var target = window.parent || window.opener;
          if (target && target !== window) {
            try {
              target.postMessage(JSON.stringify({
                event: 'pageSelected',
                page: idx
              }), '*');
            } catch(e) {}
          }
        }
      }
      return result;
    };
  }

  // Override showEntries to always force our curated library list
  if (typeof Sidebar !== 'undefined') {
    var _origShowEntries = Sidebar.prototype.showEntries;
    Sidebar.prototype.showEntries = function(entries, remember, force) {
      return _origShowEntries.call(this, DEFAULT_LIBS, false, true);
    };

    // Override addFoldingHandler to skip "Loading..." text flash
    var _origAddFoldingHandler = Sidebar.prototype.addFoldingHandler;
    Sidebar.prototype.addFoldingHandler = function(title, content, funct) {
      var initialized = false;
      var sidebar = this;

      // Hide native arrow background (we use CSS ::before triangle instead)
      title.style.backgroundImage = 'none';

      mxEvent.addListener(title, 'click', mxUtils.bind(this, function(evt) {
        if (title.contains(mxEvent.getSource(evt))) {
          if (content.style.display == 'none') {
            if (!initialized) {
              initialized = true;
              if (funct != null) {
                // Skip "Loading..." — immediately init content
                var fo = mxClient.NO_FO;
                mxClient.NO_FO = Editor.prototype.originalNoForeignObject;
                funct(content, title);
                mxClient.NO_FO = fo;
              }
            }
            sidebar.setContentVisible(content, true);
            title.style.backgroundImage = 'none';
          } else {
            title.style.backgroundImage = 'none';
            sidebar.setContentVisible(content, false);
          }
          mxEvent.consume(evt);
        }
      }));

      mxEvent.preventDefault(title);
    };
  }

  var TAB_ICON_MAP = {
    'diagram': 'space_dashboard',
    'style': 'brush',
    'text': 'title',
    'arrange': 'align_horizontal_left',
    '\u7ed8\u56fe': 'space_dashboard',
    '\u6837\u5f0f': 'brush',
    '\u6587\u672c': 'title',
    '\u6392\u5217': 'align_horizontal_left'
  };

  var ELEMENT_TAB_KEYS = ['text', 'arrange', '\u6587\u672c', '\u6392\u5217'];

  function isElementSelection(keys) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i].toLowerCase().trim();
      if (ELEMENT_TAB_KEYS.indexOf(k) >= 0) return true;
    }
    return false;
  }

  var body = document.body;

  // --- Activity Bar: hidden until font + sidebars ready ---
  var actBar = document.createElement('div');
  actBar.className = 'nanadraw-activity-bar';
  actBar.style.opacity = '0';
  actBar.style.transition = 'opacity 0.3s ease';

  var shapesBtn = document.createElement('button');
  shapesBtn.className = 'nanadraw-act-btn nanadraw-act-active';
  shapesBtn.setAttribute('data-panel', 'shapes');
  shapesBtn.title = '\u5f62\u72b6';
  shapesBtn.innerHTML = '<span class="material-symbols-outlined">pentagon</span>';
  actBar.appendChild(shapesBtn);

  var formatBtnGroup = document.createElement('div');
  formatBtnGroup.className = 'nanadraw-format-btn-group';
  actBar.appendChild(formatBtnGroup);

  var spacer = document.createElement('div');
  spacer.style.cssText = 'flex:1';
  actBar.appendChild(spacer);

  var pinBtn = document.createElement('button');
  pinBtn.className = 'nanadraw-act-btn nanadraw-act-pin';
  pinBtn.title = '\u56fa\u5b9a\u4fa7\u8fb9\u680f';
  pinBtn.innerHTML = '<span class="material-symbols-outlined" style="font-variation-settings:\'FILL\' 0">push_pin</span>';
  actBar.appendChild(pinBtn);

  body.appendChild(actBar);

  body.classList.add('nanadraw-loading');

  var fontReady = false;
  var sidebarsReady = false;

  function revealIfReady() {
    if (!fontReady || !sidebarsReady) return;
    actBar.style.opacity = '1';
    body.classList.remove('nanadraw-loading');
  }

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function() {
      fontReady = true;
      revealIfReady();
    });
  } else {
    setTimeout(function() { fontReady = true; revealIfReady(); }, 800);
  }

  // --- State ---
  var activePanel = 'shapes';
  var activeFormatKey = '';
  var expanded = false;
  var pinned = false;
  var shapeSidebar = null;
  var formatSidebar = null;
  var syncTimer = null;
  var lastFormatTabKeys = '';

  function updatePanels() {
    shapesBtn.classList.toggle('nanadraw-act-active', activePanel === 'shapes');

    var fmtBtns = formatBtnGroup.querySelectorAll('.nanadraw-act-btn');
    fmtBtns.forEach(function(b) {
      var key = b.getAttribute('data-fmt-key');
      b.classList.toggle('nanadraw-act-active',
        activePanel !== 'shapes' && key === activeFormatKey);
    });

    body.classList.toggle('nanadraw-show-format', activePanel !== 'shapes');
    body.classList.toggle('nanadraw-sidebar-open', expanded || pinned);
  }

  function clickFormatTab(key) {
    if (!formatSidebar) return;
    var tabs = formatSidebar.querySelectorAll('.geFormatTitle');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i].getAttribute('title') || tabs[i].textContent || '';
      if (t === key) { tabs[i].click(); return; }
    }
  }

  function resolveIcon(titleText) {
    var key = (titleText || '').toLowerCase().trim();
    return TAB_ICON_MAP[key] || 'tune';
  }

  function syncFormatButtons() {
    if (!formatSidebar) return;
    var tabs = formatSidebar.querySelectorAll('.geFormatTitle');

    var newKeys = [];
    tabs.forEach(function(t) {
      newKeys.push(t.getAttribute('title') || t.textContent || '');
    });
    var fingerprint = newKeys.join('|');
    if (fingerprint === lastFormatTabKeys) return;

    var oldFingerprint = lastFormatTabKeys;
    lastFormatTabKeys = fingerprint;

    formatBtnGroup.innerHTML = '';
    newKeys.forEach(function(rawTitle) {
      var icon = resolveIcon(rawTitle);
      var btn = document.createElement('button');
      btn.className = 'nanadraw-act-btn';
      btn.setAttribute('data-fmt-key', rawTitle);
      btn.title = rawTitle;
      btn.innerHTML = '<span class="material-symbols-outlined">' + icon + '</span>';
      formatBtnGroup.appendChild(btn);
    });

    if (activePanel === 'format') {
      var stillExists = newKeys.indexOf(activeFormatKey) >= 0;
      if (!stillExists && newKeys.length > 0) {
        activeFormatKey = newKeys[0];
        clickFormatTab(activeFormatKey);
      } else if (!stillExists) {
        activePanel = 'shapes';
        activeFormatKey = '';
      }
    } else if (oldFingerprint !== '' && isElementSelection(newKeys)) {
      activePanel = 'format';
      activeFormatKey = newKeys[0];
      expanded = true;
      clickFormatTab(activeFormatKey);
    }

    updatePanels();
  }

  function debouncedSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncFormatButtons, 80);
  }

  actBar.addEventListener('click', function(e) {
    var shapeHit = e.target.closest('[data-panel="shapes"]');
    if (shapeHit) {
      if (activePanel === 'shapes' && (expanded || pinned)) {
        if (!pinned) expanded = false;
      } else {
        activePanel = 'shapes';
        expanded = true;
      }
      updatePanels();
      return;
    }

    var fmtHit = e.target.closest('[data-fmt-key]');
    if (fmtHit) {
      var key = fmtHit.getAttribute('data-fmt-key');
      if (activePanel === 'format' && key === activeFormatKey && (expanded || pinned)) {
        if (!pinned) expanded = false;
      } else {
        activePanel = 'format';
        activeFormatKey = key;
        expanded = true;
        clickFormatTab(key);
      }
      updatePanels();
      return;
    }

    var pinHit = e.target.closest('.nanadraw-act-pin');
    if (pinHit) {
      pinned = !pinned;
      if (pinned) expanded = true;
      body.classList.toggle('nanadraw-pin-left', pinned);
      var icon = pinHit.querySelector('.material-symbols-outlined');
      if (icon) {
        icon.style.fontVariationSettings = pinned ? "'FILL' 1" : "'FILL' 0";
      }
      pinHit.title = pinned ? '\u53d6\u6d88\u56fa\u5b9a' : '\u56fa\u5b9a\u4fa7\u8fb9\u680f';
      updatePanels();
    }
  });

  actBar.addEventListener('mouseenter', function() {
    expanded = true;
    updatePanels();
  });
  actBar.addEventListener('mouseleave', function() {
    if (!pinned) { expanded = false; updatePanels(); }
  });

  // --- Triangle indicators for shape categories ---
  function initCategoryTriangles(sidebar) {
    if (!sidebar) return;

    function isContentVisible(title) {
      // addPalette structure: a.geTitle → outer div → inner div.geSidebar
      var outer = title.nextElementSibling;
      if (!outer || outer.tagName === 'A') return false;
      var inner = outer.querySelector('.geSidebar');
      if (inner) return inner.style.display !== 'none';
      // fallback: check the outer div itself
      return outer.style.display !== 'none';
    }

    function syncTriangles() {
      var titles = sidebar.querySelectorAll('a.geTitle');
      titles.forEach(function(title) {
        title.classList.toggle('nanadraw-expanded', isContentVisible(title));
      });
    }
    syncTriangles();

    var triObserver = new MutationObserver(function() {
      setTimeout(syncTriangles, 40);
    });
    triObserver.observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

    sidebar.addEventListener('click', function(e) {
      var title = e.target.closest('a.geTitle');
      if (title) {
        [80, 200, 400].forEach(function(d) { setTimeout(syncTriangles, d); });
      }
    });
  }

  // --- Phase 2: Hook up sidebars once DOM is ready ---
  var POLL_INTERVAL = 100;
  var MAX_POLLS = 80;
  var polls = 0;

  function hookSidebars() {
    shapeSidebar = body.querySelector(':scope > .geSidebarContainer:not(.geFormatContainer)');
    formatSidebar = body.querySelector(':scope > .geSidebarContainer.geFormatContainer');
    if (!shapeSidebar || !formatSidebar) {
      if (++polls < MAX_POLLS) setTimeout(hookSidebars, POLL_INTERVAL);
      return;
    }

    syncFormatButtons();

    var observer = new MutationObserver(debouncedSync);
    observer.observe(formatSidebar, { childList: true, subtree: true });

    [shapeSidebar, formatSidebar].forEach(function(sidebar) {
      sidebar.addEventListener('mouseenter', function() {
        expanded = true;
        updatePanels();
      });
      sidebar.addEventListener('mouseleave', function() {
        if (!pinned) { expanded = false; updatePanels(); }
      });
    });

    removeGitHubLink();
    initCategoryTriangles(shapeSidebar);

    sidebarsReady = true;
    revealIfReady();
  }

  function removeGitHubLink() {
    var tabContainer = body.querySelector(':scope > .geTabContainer');
    if (!tabContainer) return;

    var ghLinks = tabContainer.querySelectorAll('a[href*="github.com"]');
    ghLinks.forEach(function(link) { link.remove(); });

    var tabObserver = new MutationObserver(function() {
      var links = tabContainer.querySelectorAll('a[href*="github.com"]');
      links.forEach(function(link) { link.remove(); });
    });
    tabObserver.observe(tabContainer, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookSidebars);
  } else {
    hookSidebars();
  }
})();
