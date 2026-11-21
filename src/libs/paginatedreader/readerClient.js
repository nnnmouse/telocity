/** @type {((text: string, options?: { stripEmpty?: boolean }) => string) | null} */
// oxlint-disable-next-line prefer-const
let stripGarbageNewLines = null; // [INJECT_STRIP_GARBAGE]

/** @type {((text: string) => boolean) | null} */
// oxlint-disable-next-line prefer-const
let isJsonl = null; // [INJECT_IS_JSONL]

/** @type {((text: string) => string) | null} */
// oxlint-disable-next-line prefer-const
let extractText = null; // [INJECT_EXTRACT_TEXT]

/** @type {((text: string) => string) | null} */
// oxlint-disable-next-line prefer-const
let fastHash = null; // [INJECT_FAST_HASH]

/** @type {((text: string) => string) | null} */
// oxlint-disable-next-line prefer-const
let stripMarkdownFormatting = null; // [INJECT_STRIP_MARKDOWN]

/**
 * @typedef {Object} PageData
 * @property {string} title
 * @property {string} recalcTitle
 * @property {string} fontSizeLabel
 * @property {string} sizeVSmall
 * @property {string} sizeSmall
 * @property {string} sizeNormal
 * @property {string} sizeMedium
 * @property {string} sizeMediumL
 * @property {string} sizeLarge
 * @property {string} sizeXLarge
 * @property {string} sizeHXLarge
 * @property {string} sizeTXLarge
 * @property {string} sizeTHXLarge
 * @property {string} themeToggleTitle
 * @property {string} libraryTitle
 * @property {string} loadBtn
 * @property {string} previousBtn
 * @property {string} nextBtn
 * @property {string} instructions
 * @property {string} closeBtn
 * @property {string} importLabel
 * @property {string} syncLabel
 * @property {string} syncBtn
 * @property {string} emptyLibrary
 * @property {string} deleteBtn
 * @property {string} confirmDelete
 * @property {string} loadingMsg
 * @property {string} [recalcProgressMsg]
 * @property {string} [reflowingMsg]
 * @property {string} [contentLoadError]
 * @property {string} [seekingPageMsg]
 * @property {boolean} hasActiveBook
 * @property {boolean} isCli
 */

/** @type {HTMLScriptElement | null} */
const pageDataContainer = /** @type {HTMLScriptElement | null} */ (
  document.getElementById("page-data-container")
);

/** @type {PageData} */
const pageData = JSON.parse(
  pageDataContainer && pageDataContainer.textContent
    ? pageDataContainer.textContent
    : "{}",
);

const LOC_SCALE = 150;

// --- IndexedDB Management Service ---
const DB_NAME = "TelocityReaderDB";
const DB_VERSION = 3;

/** @type {IDBDatabase | null} */
let dbInstance = null;

/**
 * @typedef {Object} BookRecord
 * @property {string} bookId
 * @property {string} title
 * @property {string} content
 * @property {number} timestamp
 */

/**
 * @typedef {Object} MetadataRecord
 * @property {string} bookId
 * @property {number} [lastPage]
 * @property {string} [lastFontSize]
 * @property {number} [lastCharacterOffset]
 * @property {number} [lastUpdated]
 */

/**
 * @typedef {Object} PaginationCacheRecord
 * @property {string} cacheKey
 * @property {string} bookId
 * @property {string} layoutKey
 * @property {Uint32Array | number[]} pageBreaks
 */

/**
 * @typedef {Object} CacheTrackerRecord
 * @property {string} cacheKey
 * @property {string} bookId
 * @property {number} lastUpdated
 */

/**
 * @returns {Promise<IDBDatabase | null>}
 */
// oxlint-disable-next-line require-await
async function getDB() {
  if (dbInstance) return dbInstance;
  if (!window.indexedDB) return null;
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const target = /** @type {IDBOpenDBRequest} */ (e.target);
      const db = /** @type {IDBDatabase} */ (target.result);
      if (!db.objectStoreNames.contains("books")) {
        db.createObjectStore("books", { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains("metadata")) {
        db.createObjectStore("metadata", { keyPath: "bookId" });
      }
      if (!db.objectStoreNames.contains("pagination")) {
        db.createObjectStore("pagination", { keyPath: "cacheKey" });
      }
      if (!db.objectStoreNames.contains("cache_tracker")) {
        const tracker = db.createObjectStore("cache_tracker", {
          keyPath: "cacheKey",
        });
        tracker.createIndex("by_date", "lastUpdated", { unique: false });
        tracker.createIndex("by_book", "bookId", { unique: false });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(dbInstance);
    };
    req.onerror = (e) => {
      console.warn("IDB open failed", e);
      resolve(null);
    };
  });
}

/**
 * @param {string} id
 * @returns {Promise<BookRecord | null>}
 */
async function getBookContent(id) {
  const db = await getDB();
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction("books", "readonly");
    const req = tx.objectStore("books").get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => res(null);
  });
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} content
 * @returns {Promise<void>}
 */
async function saveBookContent(id, title, content) {
  const db = await getDB();
  if (!db) return;
  return new Promise((res) => {
    const tx = db.transaction("books", "readwrite");
    tx.objectStore("books").put({
      bookId: id,
      title: title,
      content: content,
      timestamp: Date.now(),
    });
    tx.oncomplete = () => res();
  });
}

/**
 * @param {string} id
 * @returns {Promise<MetadataRecord | null>}
 */
async function getMetadata(id) {
  const db = await getDB();
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction("metadata", "readonly");
    const req = tx.objectStore("metadata").get(id);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => res(null);
  });
}

/**
 * @param {string} bookId
 * @param {number} lastPage
 * @param {string} lastFontSize
 * @param {number} lastCharacterOffset
 * @returns {Promise<void>}
 */
async function saveMetadata(
  bookId,
  lastPage,
  lastFontSize,
  lastCharacterOffset,
) {
  if (!bookId) return;
  const db = await getDB();
  if (!db) return;
  return new Promise((res) => {
    const tx = db.transaction("metadata", "readwrite");
    const store = tx.objectStore("metadata");
    const req = store.get(bookId);
    req.onsuccess = () => {
      /** @type {MetadataRecord} */
      const current = req.result || { bookId: bookId };
      current.lastPage = lastPage;
      current.lastFontSize = lastFontSize;
      current.lastCharacterOffset = lastCharacterOffset;
      current.lastUpdated = Date.now();
      store.put(current);
    };
    tx.oncomplete = () => res();
  });
}

/**
 * @param {string} cacheKey
 * @returns {Promise<PaginationCacheRecord | null>}
 */
async function getPaginationCache(cacheKey) {
  const db = await getDB();
  if (!db) return null;
  return new Promise((res) => {
    const tx = db.transaction("pagination", "readonly");
    const req = tx.objectStore("pagination").get(cacheKey);
    req.onsuccess = () => res(req.result || null);
    req.onerror = () => res(null);
  });
}

/**
 * @param {string} bookId
 * @param {{ cacheKey: string, bookId: string, layoutKey: string, pageBreaks: Uint32Array | number[] }} cacheObj
 * @returns {Promise<void>}
 */
async function savePaginationCache(bookId, cacheObj) {
  const db = await getDB();
  if (!db) return;
  return new Promise((res) => {
    const tx = db.transaction(["pagination", "cache_tracker"], "readwrite");

    tx.objectStore("pagination").put({
      cacheKey: cacheObj.cacheKey,
      bookId: cacheObj.bookId,
      layoutKey: cacheObj.layoutKey,
      pageBreaks: new Uint32Array(cacheObj.pageBreaks),
    });

    tx.objectStore("cache_tracker").put({
      cacheKey: cacheObj.cacheKey,
      bookId: cacheObj.bookId,
      lastUpdated: Date.now(),
    });

    const trackerStore = tx.objectStore("cache_tracker");
    const pagStore = tx.objectStore("pagination");
    const bookIndex = trackerStore.index("by_book");
    const getReq = bookIndex.getAll(bookId);

    getReq.onsuccess = () => {
      const entries = /** @type {CacheTrackerRecord[]} */ (getReq.result);
      if (entries.length > 3) {
        entries.sort((a, b) => a.lastUpdated - b.lastUpdated);
        const toDelete = entries.slice(0, entries.length - 3);
        for (const item of toDelete) {
          trackerStore.delete(item.cacheKey);
          pagStore.delete(item.cacheKey);
        }
      }
    };

    tx.oncomplete = () => res();
  });
}

/**
 * @param {string} bookId
 * @param {string} cacheKey
 * @returns {Promise<void>}
 */
async function touchCache(bookId, cacheKey) {
  const db = await getDB();
  if (!db) return;
  return new Promise((res) => {
    const tx = db.transaction("cache_tracker", "readwrite");
    tx.objectStore("cache_tracker").put({
      cacheKey: cacheKey,
      bookId: bookId,
      lastUpdated: Date.now(),
    });
    tx.oncomplete = () => res();
  });
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteBook(id) {
  const db = await getDB();
  if (!db) return;
  return new Promise((res) => {
    const tx = db.transaction(
      ["books", "metadata", "pagination", "cache_tracker"],
      "readwrite",
    );
    tx.objectStore("books").delete(id);
    tx.objectStore("metadata").delete(id);
    const tracker = tx.objectStore("cache_tracker");
    const idx = tracker.index("by_book");
    const req = idx.getAll(id);
    req.onsuccess = () => {
      const results = /** @type {CacheTrackerRecord[]} */ (req.result);
      results.forEach((r) => {
        tx.objectStore("pagination").delete(r.cacheKey);
        tracker.delete(r.cacheKey);
      });
    };
    tx.oncomplete = () => res();
  });
}

/**
 * @extends {HTMLElement}
 */
class TelocityHeader extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    /** @type {number} */
    this.tapCount = 0;
    /** @type {number} */
    this.lastTapTime = 0;
  }

  static get observedAttributes() {
    return ["book-title"];
  }

  /**
   * @param {string} name
   * @param {string} _oldVal
   * @param {string} newVal
   */
  attributeChangedCallback(name, _oldVal, newVal) {
    if (
      name === "book-title" &&
      this.shadowRoot &&
      this.shadowRoot.getElementById("header-title")
    ) {
      const titleEl = this.shadowRoot.getElementById("header-title");
      if (titleEl) titleEl.textContent = newVal || pageData.title;
    }
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = /* HTML */ `
      <style>
        :host {
          display: block;
          flex-shrink: 0;
          position: relative;
          z-index: 10;
        }
        .header {
          padding: 2px 6px 2px 10px;
          background-color: var(--header-bg-color);
          border-bottom: 1px solid var(--border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
          transition:
            background-color 0.3s ease,
            border-color 0.3s ease;
        }
        .header h1 {
          font-size: 0.75rem;
          color: var(--header-text-color);
          font-weight: 500;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: calc(100% - 250px);
          transition: color 0.3s ease;
          cursor: default;
        }
        .header-controls {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .font-size-control {
          display: flex;
          align-items: center;
        }
        .font-size-control select {
          margin: 0;
          height: 1.25rem;
          -webkit-appearance: none;
          appearance: none;
          background-color: var(--input-bg-color);
          border: 1px solid var(--input-border-color);
          border-radius: 3px;
          padding: 0 14px 0 5px;
          font-size: 0.7rem;
          color: var(--input-text-color);
          cursor: pointer;
          background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 20 20'%3e%3cpath stroke='%236b7280' stroke-linecap='round' stroke-linejoin='round' stroke-width='1.5' d='M6 8l4 4 4-4'/%3e%3c/svg%3e");
          background-position: right 0.25rem center;
          background-repeat: no-repeat;
          background-size: 1.25em 1.25em;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
        }
        .font-size-control select:focus {
          outline: none;
          border-color: var(--input-focus-border-color);
          box-shadow: 0 0 0 3px var(--input-focus-shadow-color);
        }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        button {
          background-color: var(--button-bg-color);
          color: var(--button-text-color);
          border: none;
          height: 1.25rem;
          padding: 0 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 0.7rem;
          font-weight: 500;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        button.recalc-button {
          display: none;
          background: none;
          background-color: transparent;
          border: none;
          outline: none;
          -webkit-tap-highlight-color: transparent;
          cursor: pointer;
          height: 1.25rem;
          width: 1.25rem;
          padding: 0;
          border-radius: 50%;
          align-items: center;
          justify-content: center;
          color: var(--header-text-color);
          transition: background-color 0.2s ease;
        }
        button.recalc-button.visible {
          display: inline-flex;
        }
        button.theme-toggle {
          background: none;
          background-color: transparent;
          border: none;
          outline: none;
          box-shadow: none;
          -webkit-tap-highlight-color: transparent;
          cursor: pointer;
          height: 1.25rem;
          width: 1.25rem;
          padding: 0;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--header-text-color);
          transition: background-color 0.2s ease;
        }
        .icon {
          width: 10px;
          height: 10px;
        }
        .sun-icon {
          display: block;
        }
        .moon-icon {
          display: none;
        }
        :host-context(html[data-theme="dark"]) .sun-icon {
          display: none;
        }
        :host-context(html[data-theme="dark"]) .moon-icon {
          display: block;
        }
        .page-info {
          font-size: 0.7rem;
          color: var(--info-text-color);
          font-weight: 500;
          font-variant-numeric: tabular-nums;
        }
        @media (hover: hover) {
          button.recalc-button:hover,
          button.theme-toggle:hover {
            background-color: var(--theme-toggle-hover-bg);
          }
        }
        @media (max-width: 768px) {
          .header {
            padding: 2px 8px 2px 15px;
          }
          .header h1 {
            font-size: 0.85rem;
            max-width: calc(100% - 150px);
          }
          button.recalc-button {
            padding: 0;
            height: 1.8rem;
            width: 1.8rem;
          }
          .recalc-button .icon {
            width: 1.1rem;
            height: 1.1rem;
          }
          button.theme-toggle {
            padding: 0;
            height: 1.8rem;
            width: 1.8rem;
            margin-left: 4px;
          }
          button.theme-toggle .icon {
            width: 1.1rem;
            height: 1.1rem;
          }
          .font-size-control select {
            font-size: 0.75rem;
            height: 1.8rem;
            padding: 0 20px 0 6px;
            border-radius: 6px;
          }
          .page-info {
            display: none;
          }
        }
      </style>
      <div class="header">
        <h1 id="header-title">
          ${this.getAttribute("book-title") || pageData.title}
        </h1>
        <div class="header-controls">
          <button
            type="button"
            id="recalc-button"
            class="recalc-button"
            title="${pageData.recalcTitle}"
          >
            <svg
              class="icon recalc-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <polyline points="21 3 21 8 16 8" />
            </svg>
          </button>
          <div class="font-size-control">
            <label for="font-size-selector" class="sr-only"
              >${pageData.fontSizeLabel}</label
            >
            <select id="font-size-selector">
              <option value="0.7rem">${pageData.sizeVSmall}</option>
              <option value="0.9rem">${pageData.sizeSmall}</option>
              <option value="1.0rem" selected>${pageData.sizeNormal}</option>
              <option value="1.1rem">${pageData.sizeMedium}</option>
              <option value="1.2rem">${pageData.sizeMediumL}</option>
              <option value="1.3rem">${pageData.sizeLarge}</option>
              <option value="1.5rem">${pageData.sizeXLarge}</option>
              <option value="1.6rem">${pageData.sizeHXLarge}</option>
              <option value="1.7rem">${pageData.sizeTXLarge}</option>
              <option value="1.8rem">${pageData.sizeTHXLarge}</option>
            </select>
          </div>
          <div class="page-info" id="page-info"></div>
          <button
            id="theme-toggle"
            class="theme-toggle"
            title="${pageData.themeToggleTitle}"
          >
            <svg
              class="icon sun-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="M4.93 4.93l1.41 1.41" />
              <path d="M17.66 17.66l1.41 1.41" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="M6.34 17.66l-1.41 1.41" />
              <path d="M19.07 4.93l-1.41 1.41" />
            </svg>
            <svg
              class="icon moon-icon"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          </button>
        </div>
      </div>
    `;

    const titleEl = this.shadowRoot.getElementById("header-title");
    if (titleEl) {
      titleEl.addEventListener(
        "touchstart",
        (_e) => {
          const currentTime = Date.now();
          const tapDelay = currentTime - this.lastTapTime;
          if (tapDelay < 400) {
            this.tapCount++;
          } else {
            this.tapCount = 1;
          }
          this.lastTapTime = currentTime;
          if (this.tapCount === 3) {
            this.tapCount = 0;
            this.toggleRecalcButton();
          }
        },
        { passive: true },
      );
    }

    const sizeSelector = /** @type {HTMLSelectElement | null} */ (
      this.shadowRoot.getElementById("font-size-selector")
    );
    if (sizeSelector) {
      sizeSelector.addEventListener("change", (e) => {
        const target = /** @type {HTMLSelectElement} */ (e.target);
        this.dispatchEvent(
          new CustomEvent("font-size-changed", {
            detail: { fontSize: target.value },
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    const themeToggle = this.shadowRoot.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("theme-toggle-requested", {
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    const recalcBtn = this.shadowRoot.getElementById("recalc-button");
    if (recalcBtn) {
      recalcBtn.addEventListener("click", (e) => {
        e.preventDefault();
        this.dispatchEvent(
          new CustomEvent("recalc-requested", {
            bubbles: true,
            composed: true,
          }),
        );
      });
    }
  }

  toggleRecalcButton() {
    if (!this.shadowRoot) return;
    const btn = this.shadowRoot.getElementById("recalc-button");
    if (btn) btn.classList.toggle("visible");
  }

  /**
   * @param {string} size
   */
  setFontSize(size) {
    if (!this.shadowRoot) return;
    const sel = /** @type {HTMLSelectElement | null} */ (
      this.shadowRoot.getElementById("font-size-selector")
    );
    if (sel) sel.value = size;
  }

  /**
   * @param {string} statusText
   */
  updateStatus(statusText) {
    if (!this.shadowRoot) return;
    const el = this.shadowRoot.getElementById("page-info");
    if (el) el.textContent = statusText;
  }
}
customElements.define("telocity-header", TelocityHeader);

/**
 * @extends {HTMLElement}
 */
class TelocityViewport extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    /** @type {number} */
    this.currentPage = 1;
    /** @type {number} */
    this.totalPages = 1;
    /** @type {number} */
    this.estimatedTotalPages = 1;
    /** @type {number} */
    this.pageStepWidth = 0;
    /** @type {number[] | Uint32Array} */
    this.pageBreaks = [0];
    /** @type {boolean} */
    this.isPaginating = false;
    /** @type {number} */
    this.paginationRunId = 0;
    /** @type {number} */
    this.renderCenterPage = 1;
    /** @type {number | null} */
    this.pendingTargetOffset = null;
    /** @type {number | null} */
    this.pendingTargetPage = null;
    /** @type {number} */
    this.lastUserOffset = 0;
    /** @type {number} */
    this.viewportHeight = 0;
    /** @type {HTMLDivElement | null} */
    this.measuringDiv = null;

    /** @type {number} */
    this.touchStartX = 0;
    /** @type {number} */
    this.touchStartY = 0;

    /** @type {number} */
    this.wheelAccumulatorX = 0;
    /** @type {number} */
    this.wheelAccumulatorY = 0;
    /** @type {boolean} */
    this.wheelLocked = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.wheelUnlockTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.wheelResetTimer = null;

    /** @type {number} */
    this.WHEEL_THRESHOLD = 80;
    /** @type {number} */
    this.WHEEL_COOLDOWN = 450;
    /** @type {number} */
    this.WHEEL_RESET_TIMEOUT = 150;

    /** @type {Intl.Segmenter} */
    this.segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  }

  static get observedAttributes() {
    return ["font-size"];
  }

  /**
   * @param {string} name
   * @param {string} _oldVal
   * @param {string} newVal
   */
  attributeChangedCallback(name, _oldVal, newVal) {
    if (name === "font-size" && newVal) {
      this.style.setProperty("--reader-font-size", newVal);
      if (this.measuringDiv) {
        this.measuringDiv.style.fontSize = newVal;
      }
    }
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = /* HTML */ `
      <style>
        :host {
          display: block;
          flex-grow: 1;
          overflow: hidden;
          position: relative;
          cursor: default;
          width: 100%;
          height: 100%;
        }
        .page-viewport {
          height: 100%;
          width: 100%;
          overflow: hidden;
          position: relative;
        }
        #page-slider {
          height: 100%;
          width: 100%;
          will-change: transform;
          transform: translateZ(0);
          position: relative;
        }
        .page-content {
          position: absolute;
          top: 0;
          height: 100%;
          padding: 5px 40px;
          overflow: hidden;
          font-family:
            "Noto Serif", "Noto Serif CJK SC", "Noto Serif CJK JP",
            "Noto Serif CJK KR", "Noto Naskh Arabic", "Noto Serif Devanagari",
            serif;
          font-size: var(--reader-font-size, 1rem);
          line-height: 1.8;
          white-space: pre-wrap;
          word-break: break-word;
          text-align: justify;
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          font-variant-ligatures: none;
          color: var(--text-color);
          box-sizing: border-box;
        }
        @media (max-width: 768px) {
          .page-content {
            padding: 10px 20px;
            text-align: left;
          }
        }
      </style>
      <div class="page-viewport" id="page-viewport-wrapper">
        <div id="page-slider"></div>
      </div>
    `;

    const wrapper = this.shadowRoot.getElementById("page-viewport-wrapper");
    if (!wrapper) return;

    wrapper.addEventListener(
      "touchstart",
      (e) => {
        const ev = /** @type {TouchEvent} */ (e);
        if (ev.touches.length > 0) {
          const touch = ev.touches[0];
          if (touch) {
            this.touchStartX = touch.clientX;
            this.touchStartY = touch.clientY;
          }
        }
      },
      { passive: true },
    );

    wrapper.addEventListener(
      "touchend",
      (e) => {
        const ev = /** @type {TouchEvent} */ (e);
        if (ev.changedTouches.length > 0) {
          const touch = ev.changedTouches[0];
          if (touch) {
            const touchEndX = touch.clientX;
            const touchEndY = touch.clientY;
            const diffX = touchEndX - this.touchStartX;
            const diffY = touchEndY - this.touchStartY;

            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
              if (diffX > 0) {
                this.goToPreviousPage();
              } else {
                this.goToNextPage();
              }
            }
          }
        }
      },
      { passive: true },
    );

    wrapper.addEventListener(
      "wheel",
      (e) => {
        const ev = /** @type {WheelEvent} */ (e);
        ev.preventDefault();
        if (this.wheelLocked) return;

        if (this.wheelResetTimer) {
          clearTimeout(this.wheelResetTimer);
        }
        this.wheelResetTimer = setTimeout(() => {
          this.wheelAccumulatorX = 0;
          this.wheelAccumulatorY = 0;
        }, this.WHEEL_RESET_TIMEOUT);

        this.wheelAccumulatorX += ev.deltaX;
        this.wheelAccumulatorY += ev.deltaY;

        const absX = Math.abs(this.wheelAccumulatorX);
        const absY = Math.abs(this.wheelAccumulatorY);

        if (absX >= this.WHEEL_THRESHOLD || absY >= this.WHEEL_THRESHOLD) {
          this.wheelLocked = true;
          if (absY >= absX) {
            if (this.wheelAccumulatorY > 0) {
              this.goToNextPage();
            } else {
              this.goToPreviousPage();
            }
          } else {
            if (this.wheelAccumulatorX > 0) {
              this.goToNextPage();
            } else {
              this.goToPreviousPage();
            }
          }

          this.wheelAccumulatorX = 0;
          this.wheelAccumulatorY = 0;

          if (this.wheelUnlockTimer) {
            clearTimeout(this.wheelUnlockTimer);
          }
          this.wheelUnlockTimer = setTimeout(() => {
            this.wheelLocked = false;
          }, this.WHEEL_COOLDOWN);
        }
      },
      { passive: false },
    );
  }

  /**
   * @returns {boolean}
   */
  setupMeasuringDiv() {
    if (!this.shadowRoot) return false;
    if (this.measuringDiv) {
      this.measuringDiv.remove();
    }
    const rect = this.getBoundingClientRect();
    this.pageStepWidth = rect.width;
    this.viewportHeight = rect.height;

    this.measuringDiv = document.createElement("div");
    this.measuringDiv.className = "page-content";
    Object.assign(this.measuringDiv.style, {
      position: "absolute",
      top: "-9999px",
      left: "-9999px",
      width: this.pageStepWidth + "px",
      height: this.viewportHeight + "px",
      visibility: "hidden",
      fontSize: this.getAttribute("font-size") || "1.0rem",
      boxSizing: "border-box",
      overflow: "hidden",
    });
    this.shadowRoot.appendChild(this.measuringDiv);
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * @param {string} bookId
   * @param {string} fullText
   * @param {number} [targetOffset]
   * @param {boolean} [forceRecalculate]
   * @returns {Promise<void>}
   */
  async startPagination(
    bookId,
    fullText,
    targetOffset = 0,
    forceRecalculate = false,
  ) {
    this.paginationRunId++;
    const currentRunId = this.paginationRunId;

    this.currentPage = 1;
    this.totalPages = 1;
    this.estimatedTotalPages = 1;
    this.isPaginating = true;
    this.renderCenterPage = 1;
    this.pendingTargetOffset = targetOffset;
    this.pendingTargetPage = null;
    this.lastUserOffset = targetOffset;

    this.dispatchEvent(
      new CustomEvent("pagination-started", {
        detail: { forceRecalculate },
        bubbles: true,
        composed: true,
      }),
    );

    let valid = this.setupMeasuringDiv();
    if (!valid) {
      let retries = 0;
      while (!valid && retries < 10) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (currentRunId !== this.paginationRunId) return;
        valid = this.setupMeasuringDiv();
        retries++;
      }
      if (!valid) {
        this.dispatchEvent(
          new CustomEvent("pagination-failed", {
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
    }

    const fontSize = this.getAttribute("font-size") || "1.0rem";
    const layoutKey =
      Math.round(this.pageStepWidth) +
      "x" +
      Math.round(this.viewportHeight) +
      "_" +
      fontSize;
    const cacheKey = bookId + "_" + fullText.length + "_" + layoutKey;

    const cached = forceRecalculate ? null : await getPaginationCache(cacheKey);

    if (cached) {
      touchCache(bookId, cacheKey).catch((e) =>
        console.warn("Cache touch error", e),
      );
      this.pageBreaks = cached.pageBreaks;
      this.totalPages = this.pageBreaks.length - 1;
      this.estimatedTotalPages = this.totalPages;
      this.isPaginating = false;

      this.dispatchEvent(
        new CustomEvent("pagination-finished", {
          bubbles: true,
          composed: true,
        }),
      );

      let resolvedPage = 1;
      for (let i = 1; i < this.pageBreaks.length; i++) {
        const startBreak = this.pageBreaks[i - 1] ?? 0;
        const endBreak = this.pageBreaks[i] ?? 0;
        if (targetOffset >= startBreak && targetOffset < endBreak) {
          resolvedPage = i;
          break;
        }
      }
      const lastBreak = this.pageBreaks[this.pageBreaks.length - 1] ?? 0;
      if (targetOffset >= lastBreak) {
        resolvedPage = Math.max(1, this.pageBreaks.length - 1);
      }

      this.pendingTargetOffset = null;
      this.goToPage(fullText, resolvedPage, false, true);
    } else {
      this.pageBreaks = [0];
      requestAnimationFrame(() =>
        this.processPaginationChunk(
          currentRunId,
          bookId,
          fullText,
          cacheKey,
          layoutKey,
        ),
      );
    }
  }

  /**
   * @param {number} runId
   * @param {string} bookId
   * @param {string} fullText
   * @param {string} cacheKey
   * @param {string} layoutKey
   * @returns {void}
   */
  processPaginationChunk(runId, bookId, fullText, cacheKey, layoutKey) {
    if (runId !== this.paginationRunId || !this.measuringDiv) return;

    const startTime = performance.now();
    const totalLen = fullText.length;
    const timeBudget = 12;

    let currentOffset = this.pageBreaks[this.pageBreaks.length - 1] ?? 0;
    let lastPageLength = 3000;
    if (this.pageBreaks.length > 1) {
      const lastBreak = this.pageBreaks[this.pageBreaks.length - 1] ?? 0;
      const secondLastBreak = this.pageBreaks[this.pageBreaks.length - 2] ?? 0;
      lastPageLength = lastBreak - secondLastBreak;
    }

    const clientHeight = this.measuringDiv.clientHeight;

    while (currentOffset < totalLen) {
      const remainingLength = totalLen - currentOffset;

      /** @type {number} */
      let low = 0;
      /** @type {number} */
      let high = 0;

      if (this.pageBreaks.length === 1) {
        low = 0;
        high = Math.min(5000, remainingLength);
      } else {
        low = Math.floor(lastPageLength * 0.8);
        high = Math.max(3000, Math.floor(lastPageLength * 1.25));
        if (high > remainingLength) high = remainingLength;
        if (low > high) low = 0;
      }

      let bestFitLength = 0;
      this.measuringDiv.textContent = fullText.substring(
        currentOffset,
        currentOffset + high,
      );

      if (this.measuringDiv.scrollHeight <= clientHeight + 1) {
        bestFitLength = high;
        low = high;
        while (high < remainingLength) {
          high = Math.min(high + 1000, remainingLength);
          this.measuringDiv.textContent = fullText.substring(
            currentOffset,
            currentOffset + high,
          );
          if (this.measuringDiv.scrollHeight > clientHeight) break;
          bestFitLength = high;
          low = high;
        }
      } else {
        if (low > 0) {
          this.measuringDiv.textContent = fullText.substring(
            currentOffset,
            currentOffset + low,
          );
          if (this.measuringDiv.scrollHeight > clientHeight) {
            high = low;
            low = 0;
          } else {
            bestFitLength = low;
          }
        }
      }

      while (low <= high) {
        const mid = (low + high) >>> 1;
        if (mid === bestFitLength) break;
        this.measuringDiv.textContent = fullText.substring(
          currentOffset,
          currentOffset + mid,
        );

        if (this.measuringDiv.scrollHeight <= clientHeight + 1) {
          bestFitLength = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      let pageEnd = currentOffset + bestFitLength;
      if (pageEnd < totalLen) {
        const lookBack = 50;
        const searchStart = Math.max(currentOffset, pageEnd - lookBack);
        const probeText = fullText.substring(searchStart, pageEnd + 1);
        const segments = this.segmenter.segment(probeText);
        let lastSafeBreak = currentOffset;

        for (const seg of segments) {
          const segStart = searchStart + seg.index;
          const segEnd = segStart + seg.segment.length;

          if (segEnd <= pageEnd) {
            lastSafeBreak = segEnd;
          } else {
            if (segStart > currentOffset) {
              lastSafeBreak = segStart;
            }
            break;
          }
        }

        if (lastSafeBreak > currentOffset) {
          pageEnd = lastSafeBreak;
        }
      }
      if (pageEnd <= currentOffset) {
        pageEnd = currentOffset + Math.max(1, bestFitLength);
      }

      if (Array.isArray(this.pageBreaks)) {
        this.pageBreaks.push(pageEnd);
      } else {
        const nextBreaks = new Uint32Array(this.pageBreaks.length + 1);
        nextBreaks.set(this.pageBreaks);
        nextBreaks[this.pageBreaks.length] = pageEnd;
        this.pageBreaks = nextBreaks;
      }

      lastPageLength = pageEnd - currentOffset;
      currentOffset = pageEnd;

      const pagesFound = this.pageBreaks.length - 1;
      let resolvedPage = null;

      const prevPageBreak = this.pageBreaks[pagesFound - 1] ?? 0;
      if (
        this.pendingTargetOffset !== null &&
        this.pendingTargetOffset >= prevPageBreak &&
        (pageEnd > this.pendingTargetOffset || pageEnd >= totalLen)
      ) {
        resolvedPage = pagesFound;
        this.pendingTargetOffset = null;
      } else if (
        this.pendingTargetPage !== null &&
        (pagesFound >= this.pendingTargetPage || pageEnd >= totalLen)
      ) {
        resolvedPage = Math.min(pagesFound, this.pendingTargetPage);
        this.pendingTargetPage = null;
      }

      if (resolvedPage !== null) {
        this.totalPages = pagesFound;
        this.goToPage(fullText, resolvedPage, false, true);
        this.dispatchEvent(
          new CustomEvent("pagination-finished", {
            bubbles: true,
            composed: true,
          }),
        );
      }

      if (performance.now() - startTime > timeBudget) {
        break;
      }
    }

    const pagesFound = this.pageBreaks.length - 1;

    if (currentOffset >= totalLen) {
      this.isPaginating = false;
      this.totalPages = pagesFound;
      this.estimatedTotalPages = pagesFound;

      savePaginationCache(bookId, {
        cacheKey: cacheKey,
        bookId: bookId,
        layoutKey: layoutKey,
        pageBreaks: Array.from(this.pageBreaks),
      }).catch((e) => console.warn("Cache save error", e));

      this.pageBreaks = new Uint32Array(this.pageBreaks);

      if (
        this.pendingTargetPage !== null ||
        this.pendingTargetOffset !== null
      ) {
        let resolvedPage = 1;
        if (this.pendingTargetPage !== null) {
          resolvedPage = Math.min(
            this.pendingTargetPage,
            this.pageBreaks.length - 1,
          );
        } else if (this.pendingTargetOffset !== null) {
          for (let i = 1; i < this.pageBreaks.length; i++) {
            const startBreak = this.pageBreaks[i - 1] ?? 0;
            const endBreak = this.pageBreaks[i] ?? 0;
            if (
              this.pendingTargetOffset >= startBreak &&
              this.pendingTargetOffset < endBreak
            ) {
              resolvedPage = i;
              break;
            }
          }
          const lastBreak = this.pageBreaks[this.pageBreaks.length - 1] ?? 0;
          if (this.pendingTargetOffset >= lastBreak) {
            resolvedPage = Math.max(1, this.pageBreaks.length - 1);
          }
        }
        this.pendingTargetOffset = null;
        this.pendingTargetPage = null;
        this.dispatchEvent(
          new CustomEvent("pagination-finished", {
            bubbles: true,
            composed: true,
          }),
        );
        this.goToPage(fullText, resolvedPage, false, true);
      } else {
        this.dispatchEvent(
          new CustomEvent("pagination-finished", {
            bubbles: true,
            composed: true,
          }),
        );
        this.goToPage(
          fullText,
          Math.min(this.currentPage, this.totalPages),
          false,
        );
      }
    } else {
      const avgChars = currentOffset / pagesFound;
      const remainingChars = totalLen - currentOffset;
      const estRemaining = Math.ceil(remainingChars / avgChars);
      this.estimatedTotalPages = pagesFound + estRemaining;
      this.totalPages = pagesFound;

      if (
        this.pendingTargetOffset !== null ||
        this.pendingTargetPage !== null
      ) {
        const percent = Math.min(
          99,
          Math.floor((currentOffset / totalLen) * 100),
        );
        this.dispatchEvent(
          new CustomEvent("pagination-progress", {
            detail: { percent },
            bubbles: true,
            composed: true,
          }),
        );
      } else {
        this.dispatchUIUpdate();
      }

      setTimeout(
        () =>
          this.processPaginationChunk(
            runId,
            bookId,
            fullText,
            cacheKey,
            layoutKey,
          ),
        0,
      );
    }
  }

  /**
   * @param {string} fullText
   * @returns {void}
   */
  renderVirtualPages(fullText) {
    if (!this.shadowRoot) return;
    const slider = this.shadowRoot.getElementById("page-slider");
    if (!slider) return;
    slider.innerHTML = "";
    const startPage = Math.max(1, this.renderCenterPage - 2);
    const endPage = Math.min(
      this.pageBreaks.length - 1,
      this.renderCenterPage + 2,
    );

    const frag = document.createDocumentFragment();

    for (let i = startPage; i <= endPage; i++) {
      const pageDiv = document.createElement("div");
      pageDiv.className = "page-content";
      pageDiv.style.width = this.pageStepWidth + "px";
      pageDiv.style.left =
        (i - this.renderCenterPage) * this.pageStepWidth + "px";

      const startIdx = this.pageBreaks[i - 1] ?? 0;
      const endIdx = this.pageBreaks[i] ?? 0;
      pageDiv.textContent = fullText.substring(startIdx, endIdx);

      frag.appendChild(pageDiv);
    }
    slider.appendChild(frag);
  }

  /**
   * @param {string} fullText
   * @param {number} pageNumber
   * @param {boolean} [smooth]
   * @param {boolean} [isReflow]
   * @returns {void}
   */
  goToPage(fullText, pageNumber, smooth = true, isReflow = false) {
    if (!this.shadowRoot) return;
    let target = Math.floor(pageNumber);
    if (!target || target < 1) target = 1;

    if (target < this.pageBreaks.length) {
      this.pendingTargetOffset = null;
      this.pendingTargetPage = null;
      const prevPage = this.currentPage;
      this.currentPage = target;

      if (!isReflow) {
        const breakVal = this.pageBreaks[this.currentPage - 1];
        if (breakVal !== undefined) {
          this.lastUserOffset = breakVal;
        }
      }

      this.dispatchEvent(
        new CustomEvent("metadata-save-requested", {
          detail: {
            currentPage: this.currentPage,
            lastUserOffset: this.lastUserOffset,
          },
          bubbles: true,
          composed: true,
        }),
      );

      const isFarJump = Math.abs(this.currentPage - prevPage) > 2;
      const useSmooth = smooth && !isFarJump && this.currentPage !== prevPage;

      let startTx = 0;
      const slider = this.shadowRoot.getElementById("page-slider");
      if (!slider) return;

      if (useSmooth) {
        let currentTx = 0;
        const transformStr = window.getComputedStyle(slider).transform;
        if (transformStr && transformStr !== "none") {
          if (transformStr.startsWith("matrix3d")) {
            const parts = transformStr.split(",");
            const val = parts[12];
            if (val) currentTx = parseFloat(val) || 0;
          } else {
            const parts = transformStr.split(",");
            const val = parts[4];
            if (val) currentTx = parseFloat(val) || 0;
          }
        }
        startTx =
          currentTx +
          (this.currentPage - this.renderCenterPage) * this.pageStepWidth;
      }

      this.renderCenterPage = this.currentPage;
      slider.style.transition = "none";

      if (useSmooth) {
        slider.style.transform = "translate3d(" + startTx + "px, 0px, 0px)";
      } else {
        slider.style.transform = "translate3d(0px, 0px, 0px)";
      }

      this.renderVirtualPages(fullText);

      if (useSmooth) {
        // Trigger reflow
        void slider.offsetWidth;
        slider.style.transition =
          "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
        slider.style.transform = "translate3d(0px, 0px, 0px)";
      }

      this.dispatchUIUpdate();
      return;
    }

    if (this.isPaginating) {
      this.pendingTargetOffset = null;
      this.pendingTargetPage = target;
      this.dispatchEvent(
        new CustomEvent("seeking-page", {
          detail: { target },
          bubbles: true,
          composed: true,
        }),
      );
    } else {
      this.goToPage(fullText, this.totalPages, smooth);
    }
  }

  /**
   * @param {string} fullText
   * @param {string | number} locVal
   * @returns {void}
   */
  goToLocation(fullText, locVal) {
    let targetLoc = typeof locVal === "number" ? locVal : parseInt(locVal, 10);
    if (isNaN(targetLoc) || targetLoc < 0) targetLoc = 0;

    const maxLoc = Math.floor(fullText.length / LOC_SCALE);
    if (targetLoc > maxLoc) targetLoc = maxLoc;

    const targetOffset = targetLoc * LOC_SCALE;

    const lastBreak = this.pageBreaks[this.pageBreaks.length - 1] ?? 0;
    if (this.isPaginating && targetOffset >= lastBreak) {
      this.pendingTargetOffset = targetOffset;
      this.pendingTargetPage = null;
      this.dispatchEvent(
        new CustomEvent("seeking-location", {
          detail: { targetLoc },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    let targetPageIdx = 1;

    for (let i = 1; i < this.pageBreaks.length; i++) {
      const pageStartLoc = Math.floor(
        (this.pageBreaks[i - 1] ?? 0) / LOC_SCALE,
      );
      if (i === this.pageBreaks.length - 1) {
        targetPageIdx = i;
        break;
      }
      const nextPageStartLoc = Math.floor(
        (this.pageBreaks[i] ?? 0) / LOC_SCALE,
      );
      if (targetLoc >= pageStartLoc && targetLoc < nextPageStartLoc) {
        targetPageIdx = i;
        break;
      }
    }

    this.goToPage(fullText, targetPageIdx);
  }

  goToPreviousPage() {
    this.dispatchEvent(
      new CustomEvent("nav-prev-requested", { bubbles: true, composed: true }),
    );
  }

  goToNextPage() {
    this.dispatchEvent(
      new CustomEvent("nav-next-requested", { bubbles: true, composed: true }),
    );
  }

  dispatchUIUpdate() {
    this.dispatchEvent(
      new CustomEvent("viewport-ui-updated", {
        detail: {
          currentPage: this.currentPage,
          totalPages: this.totalPages,
          estimatedTotalPages: this.estimatedTotalPages,
          isPaginating: this.isPaginating,
          pageBreaks: this.pageBreaks,
          lastUserOffset: this.lastUserOffset,
          LOC_SCALE: LOC_SCALE,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
customElements.define("telocity-viewport", TelocityViewport);

/**
 * @extends {HTMLElement}
 */
class TelocityNavigation extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = /* HTML */ `
      <style>
        :host {
          display: block;
          flex-shrink: 0;
          position: relative;
          z-index: 10;
        }
        .navigation {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 2px 20px;
          background-color: var(--bg-color);
          border-top: 1px solid var(--border-color);
          transition:
            background-color 0.3s ease,
            border-color 0.3s ease;
        }
        .page-controls {
          display: flex;
          align-items: center;
          gap: 7.5px;
        }
        button {
          background-color: var(--button-bg-color);
          color: var(--button-text-color);
          border: none;
          height: 1.25rem;
          padding: 0 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 0.7rem;
          font-weight: 500;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 3px;
        }
        button:disabled {
          background-color: var(--button-disabled-bg-color);
          cursor: not-allowed;
        }
        .page-input {
          position: relative;
          display: flex;
          align-items: center;
        }
        .page-input::before {
          content: "P/L";
          position: absolute;
          left: 6px;
          font-size: 0.55rem;
          font-weight: 600;
          color: var(--info-text-color);
          opacity: 0.55;
          pointer-events: none;
        }
        input[type="text"] {
          width: 65px;
          height: 1.25rem;
          padding: 0 5px 0 24px;
          border: 1px solid var(--input-border-color);
          background-color: var(--input-bg-color);
          color: var(--input-text-color);
          border-radius: 3px;
          text-align: left;
          font-size: 0.7rem;
          transition: all 0.2s ease;
        }
        input[type="text"]:focus {
          outline: none;
          border-color: var(--input-focus-border-color);
          box-shadow: 0 0 0 3px var(--input-focus-shadow-color);
        }
        .mobile-status {
          display: none;
          font-size: 0.7rem;
          color: var(--info-text-color);
          font-weight: 500;
          font-variant-numeric: tabular-nums;
        }
        .instructions {
          font-size: 0.7rem;
          color: var(--instructions-text-color);
          margin: 0;
          display: inline-flex;
          align-items: center;
          height: 1.25rem;
          cursor: default;
        }
        @media (hover: hover) {
          button:hover {
            background-color: var(--button-hover-bg-color);
          }
        }
        @media (max-width: 768px) {
          .navigation {
            padding: 6px 10px;
            flex-direction: row;
            justify-content: space-between;
            gap: 0;
          }
          .instructions {
            display: none;
          }
          .mobile-status {
            display: block;
            font-size: 0.75rem;
          }
          .page-controls {
            gap: 8px;
          }
          #prev-button,
          #next-button {
            display: none;
          }
          button {
            font-size: 0.75rem;
            height: 1.8rem;
            padding: 0 10px;
            border-radius: 6px;
            gap: 6px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          .page-input::before {
            left: 8px;
            font-size: 0.6rem;
          }
          input[type="text"] {
            width: 85px;
            height: 1.8rem;
            padding: 0 5px 0 28px;
            font-size: 0.75rem;
            border-radius: 6px;
          }
        }
      </style>
      <div class="navigation">
        <div class="page-controls">
          <button id="library-button" title="${pageData.libraryTitle}">
            ${pageData.loadBtn}
          </button>
          <button id="prev-button" disabled>${pageData.previousBtn}</button>
          <div class="page-input">
            <input
              type="text"
              id="page-input"
              value="1"
              placeholder="P. / L..."
            />
          </div>
          <button id="next-button">${pageData.nextBtn}</button>
        </div>
        <div class="mobile-status" id="mobile-status"></div>
        <div class="instructions">${pageData.instructions}</div>
      </div>
    `;

    const libraryBtn = this.shadowRoot.getElementById("library-button");
    if (libraryBtn) {
      libraryBtn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("library-open-requested", {
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    const prevBtn = this.shadowRoot.getElementById("prev-button");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("nav-prev-requested", {
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    const nextBtn = this.shadowRoot.getElementById("next-button");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("nav-next-requested", {
            bubbles: true,
            composed: true,
          }),
        );
      });
    }

    const pageInp = /** @type {HTMLInputElement | null} */ (
      this.shadowRoot.getElementById("page-input")
    );
    if (pageInp) {
      pageInp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const target = /** @type {HTMLInputElement} */ (e.target);
          const val = target.value.trim();
          this.dispatchEvent(
            new CustomEvent("nav-input-submitted", {
              detail: { val },
              bubbles: true,
              composed: true,
            }),
          );
          target.blur();
        }
      });
    }
  }

  focusInput() {
    if (!this.shadowRoot) return;
    const inp = /** @type {HTMLInputElement | null} */ (
      this.shadowRoot.getElementById("page-input")
    );
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  /**
   * @param {number} currentPage
   * @param {number} totalPages
   * @param {number} estimatedTotalPages
   * @param {boolean} isPaginating
   * @param {string} statusText
   * @returns {void}
   */
  updateUI(
    currentPage,
    totalPages,
    estimatedTotalPages,
    isPaginating,
    statusText,
  ) {
    if (!this.shadowRoot) return;
    const inp = /** @type {HTMLInputElement | null} */ (
      this.shadowRoot.getElementById("page-input")
    );

    if (inp && this.shadowRoot.activeElement !== inp) {
      inp.value = String(currentPage);
    }

    const displayTotal = isPaginating ? estimatedTotalPages : totalPages;
    if (inp) inp.setAttribute("max", String(displayTotal));

    const prevBtn = /** @type {HTMLButtonElement | null} */ (
      this.shadowRoot.getElementById("prev-button")
    );
    if (prevBtn) prevBtn.disabled = currentPage <= 1;

    const nextBtn = /** @type {HTMLButtonElement | null} */ (
      this.shadowRoot.getElementById("next-button")
    );
    if (nextBtn) nextBtn.disabled = currentPage >= displayTotal;

    const statusEl = this.shadowRoot.getElementById("mobile-status");
    if (statusText && statusEl) {
      statusEl.textContent = statusText;
    }
  }
}
customElements.define("telocity-navigation", TelocityNavigation);

/**
 * @extends {HTMLElement}
 */
class TelocityLibrary extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = /* HTML */ `
      <style>
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 200;
          display: none;
          justify-content: center;
          align-items: center;
          backdrop-filter: blur(2px);
        }
        .modal-overlay.visible {
          display: flex;
        }
        .modal-content {
          background: var(--reader-bg-color);
          width: 95%;
          max-width: 500px;
          border-radius: 8px;
          padding: 15px;
          box-shadow: 0 4px 12px var(--shadow-color);
          max-height: 90vh;
          display: flex;
          flex-direction: column;
        }
        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          border-bottom: 1px solid var(--border-color);
          padding-bottom: 8px;
        }
        .modal-header h2 {
          font-size: 0.8rem;
          color: var(--header-text-color);
        }
        button {
          background-color: var(--button-bg-color);
          color: var(--button-text-color);
          border: none;
          height: 1.25rem;
          padding: 0 8px;
          border-radius: 3px;
          cursor: pointer;
          font-size: 0.7rem;
          font-weight: 500;
          transition: all 0.2s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .modal-body {
          overflow-y: auto;
          flex-grow: 1;
          scrollbar-width: thin;
          scrollbar-color: var(--border-color) transparent;
        }
        .modal-body::-webkit-scrollbar {
          width: 6px;
        }
        .modal-body::-webkit-scrollbar-track {
          background: transparent;
        }
        .modal-body::-webkit-scrollbar-thumb {
          background-color: var(--border-color);
          border-radius: 3px;
        }
        .modal-body::-webkit-scrollbar-thumb:hover {
          background-color: var(--button-hover-bg-color);
        }
        .book-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px;
          border-bottom: 1px solid var(--border-color);
          cursor: pointer;
          transition: background 0.2s;
        }
        .book-item:hover {
          background: var(--theme-toggle-hover-bg);
        }
        .book-info {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .book-title {
          font-weight: bold;
          font-size: 0.65rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          color: var(--text-color);
        }
        .book-meta {
          font-size: 0.5rem;
          color: var(--info-text-color);
          margin-top: 2px;
        }
        .book-actions button {
          margin-left: 10px;
          font-size: 0.45rem;
          padding: 3px 6px;
        }
        .purge-button {
          background-color: #cb3a2a;
          color: #fffbeb;
        }
        .purge-button:hover {
          background-color: #d74c3d;
        }
        :host-context(html[data-theme="dark"]) .purge-button {
          background-color: #8b2525;
          color: var(--button-text-color);
        }
        :host-context(html[data-theme="dark"]) .purge-button:hover {
          background-color: #b33636;
        }
        @media (hover: hover) {
          button:hover {
            background-color: var(--button-hover-bg-color);
          }
        }
        @media (max-width: 768px) {
          button {
            font-size: 0.75rem;
            height: 1.8rem;
            padding: 0 10px;
            border-radius: 6px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
        }
      </style>
      <div class="modal-overlay" id="library-modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2>${pageData.libraryTitle}</h2>
            <button id="close-library-btn">${pageData.closeBtn}</button>
          </div>

          <!-- Manual Import Controls -->
          <div
            style="padding: 8px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 10px; justify-content: space-between;"
          >
            <span
              style="font-size: 0.55rem; font-weight: bold; color: var(--text-color);"
              >${pageData.importLabel}</span
            >
            <input
              type="file"
              id="standalone-file-input"
              accept=".txt,.jsonl"
              style="font-size: 0.5rem; color: var(--text-color)"
            />
          </div>

          <!-- Wireless sync section -->
          <div
            id="sync-section"
            style="padding: 8px; border-bottom: 1px solid var(--border-color); display: none; flex-direction: column; gap: 5px;"
          >
            <span
              style="font-size: 0.55rem; font-weight: bold; color: var(--text-color);"
              >${pageData.syncLabel}</span
            >
            <div style="display: flex; gap: 5px; align-items: center">
              <input
                type="text"
                id="sync-url-input"
                placeholder="http://192.168.x.x:33636"
                style="flex-grow: 1; padding: 4px; font-size: 0.5rem; border: 1px solid var(--input-border-color); background: var(--input-bg-color); color: var(--input-text-color); border-radius: 3px;"
              />
              <button
                id="sync-button"
                style="padding: 4px 8px; font-size: 0.45rem"
              >
                ${pageData.syncBtn}
              </button>
            </div>
          </div>

          <div class="modal-body" id="library-list"></div>
        </div>
      </div>
    `;

    const overlay = this.shadowRoot.getElementById("library-modal");
    const closeBtn = this.shadowRoot.getElementById("close-library-btn");
    const fileInput = /** @type {HTMLInputElement | null} */ (
      this.shadowRoot.getElementById("standalone-file-input")
    );
    const syncBtn = this.shadowRoot.getElementById("sync-button");
    const syncUrlInput = /** @type {HTMLInputElement | null} */ (
      this.shadowRoot.getElementById("sync-url-input")
    );

    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close());
    }
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this.close();
      });
    }

    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const target = /** @type {HTMLInputElement} */ (e.target);
        const file = target.files ? target.files[0] : null;
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (evt) => {
          const fileReaderTarget = /** @type {FileReader} */ (evt.target);
          let text = /** @type {string} */ (fileReaderTarget.result || "");
          if (isJsonl && isJsonl(text)) {
            if (extractText) text = extractText(text);
          }
          if (stripMarkdownFormatting) {
            text = stripMarkdownFormatting(text);
          }
          if (stripGarbageNewLines) {
            text = stripGarbageNewLines(text, { stripEmpty: true });
          }

          const hashId = fastHash ? fastHash(text) : String(Date.now());
          await saveBookContent(hashId, file.name, text);
          this.close();
          window.location.hash = hashId;
        };
        reader.readAsText(file);
      });
    }

    if (syncBtn && syncUrlInput) {
      syncBtn.addEventListener("click", async () => {
        let host = syncUrlInput.value.trim();
        if (!host) {
          host = window.location.origin;
        }
        if (host.endsWith("/")) {
          host = host.slice(0, -1);
        }
        localStorage.setItem("telocity_sync_host", host);
        this.dispatchEvent(
          new CustomEvent("sync-started", { bubbles: true, composed: true }),
        );

        try {
          const res = await fetch(host + "/api/current", { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP Status " + res.status);
          const data = await res.json();
          await saveBookContent(data.bookId, data.title, data.content);
          this.close();
          window.location.hash = data.bookId;
        } catch (err) {
          const error = /** @type {Error} */ (err);
          alert("Synchronization failed: " + error.message);
          this.dispatchEvent(
            new CustomEvent("sync-failed", { bubbles: true, composed: true }),
          );
        }
      });
    }
  }

  /**
   * @param {boolean} isCli
   * @returns {void}
   */
  show(isCli) {
    if (!this.shadowRoot) return;
    const modal = this.shadowRoot.getElementById("library-modal");
    if (modal) modal.classList.add("visible");
    const syncSection = this.shadowRoot.getElementById("sync-section");
    if (syncSection) syncSection.style.display = isCli ? "flex" : "none";

    const savedSyncHost = localStorage.getItem("telocity_sync_host");
    const syncUrlInput = /** @type {HTMLInputElement | null} */ (
      this.shadowRoot.getElementById("sync-url-input")
    );
    if (savedSyncHost && syncUrlInput) {
      syncUrlInput.value = savedSyncHost;
    } else if (syncUrlInput) {
      syncUrlInput.value = window.location.origin;
    }

    this.renderLibraryList().catch((err) => console.error(err));
  }

  close() {
    if (!this.shadowRoot) return;
    const modal = this.shadowRoot.getElementById("library-modal");
    if (modal) modal.classList.remove("visible");
  }

  /**
   * @returns {boolean}
   */
  isOpen() {
    if (!this.shadowRoot) return false;
    const modal = this.shadowRoot.getElementById("library-modal");
    return modal ? modal.classList.contains("visible") : false;
  }

  /**
   * @returns {Promise<void>}
   */
  async renderLibraryList() {
    if (!this.shadowRoot) return;
    const list = this.shadowRoot.getElementById("library-list");
    if (!list) return;
    list.innerHTML = "";
    const db = await getDB();
    if (!db) {
      list.innerHTML =
        '<div style="text-align:center; padding:20px;">Storage unavailable.</div>';
      return;
    }
    const tx = db.transaction("books", "readonly");
    const store = tx.objectStore("books");
    const req = store.getAll();

    req.onsuccess = () => {
      const results = /** @type {BookRecord[]} */ (req.result);
      const books = results.sort((a, b) => b.timestamp - a.timestamp);
      if (books.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:20px; color:var(--info-text-color)">${pageData.emptyLibrary}</div>`;
      } else {
        books.forEach((b) => {
          const item = document.createElement("div");
          item.className = "book-item";

          const info = document.createElement("div");
          info.className = "book-info";
          const dt = new Date(b.timestamp).toLocaleDateString();
          info.innerHTML = `<div class="book-title">${b.title}</div><div class="book-meta">Saved: ${dt}</div>`;

          info.onclick = () => {
            this.close();
            window.location.hash = b.bookId;
          };

          const actions = document.createElement("div");
          actions.className = "book-actions";
          const delBtn = document.createElement("button");
          delBtn.className = "purge-button";
          delBtn.textContent = pageData.deleteBtn;
          delBtn.onclick = async (e) => {
            e.stopPropagation();
            if (confirm(pageData.confirmDelete)) {
              await deleteBook(b.bookId);
              this.dispatchEvent(
                new CustomEvent("book-deleted", {
                  detail: { bookId: b.bookId },
                  bubbles: true,
                  composed: true,
                }),
              );
              this.renderLibraryList().catch((err) => console.error(err));
            }
          };
          actions.appendChild(delBtn);

          item.appendChild(info);
          item.appendChild(actions);
          list.appendChild(item);
        });
      }
    };
  }
}
customElements.define("telocity-library", TelocityLibrary);

/**
 * @extends {HTMLElement}
 */
class TelocityReader extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    /** @type {string | null} */
    this.bookId = null;
    /** @type {string} */
    this.fullText = "";
    /** @type {string} */
    this.bookTitle = "";
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.metaSaveTimer = null;
    /** @type {number} */
    this.lastUserOffset = 0;

    /** @type {TelocityHeader | null} */
    this.header = null;
    /** @type {TelocityViewport | null} */
    this.viewport = null;
    /** @type {TelocityNavigation | null} */
    this.navigation = null;
    /** @type {TelocityLibrary | null} */
    this.library = null;
  }

  connectedCallback() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = /* HTML */ `
      <style>
        :host {
          display: flex;
          height: 100%;
          width: 100%;
          justify-content: center;
          align-items: center;
        }
        .reader-container {
          height: 100%;
          width: 100%;
          display: flex;
          flex-direction: column;
          background-color: var(--reader-bg-color);
          border-radius: 0;
          box-shadow: 0 4px 12px var(--shadow-color);
          overflow: hidden;
          position: relative;
        }
        .viewport-wrapper {
          position: relative;
          flex-grow: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          width: 100%;
          height: 100%;
        }
        .loading-overlay {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.1);
          backdrop-filter: blur(2px);
          z-index: 100;
          display: flex;
          justify-content: center;
          align-items: center;
          color: var(--text-color);
          font-size: 0.6rem;
          display: none;
          flex-direction: column;
          gap: 5px;
        }
        .loading-overlay.visible {
          display: flex;
        }
        .progress-bar-container {
          width: 100px;
          height: 2px;
          background: var(--border-color);
          border-radius: 1px;
          overflow: hidden;
        }
        .progress-bar-fill {
          height: 100%;
          background: var(--input-focus-border-color);
          width: 0%;
          transition: width 0.1s linear;
        }
        @media (max-width: 768px) {
          .loading-overlay {
            font-size: 1.2rem;
            gap: 10px;
          }
          .progress-bar-container {
            width: 200px;
            height: 4px;
            border-radius: 2px;
          }
        }
      </style>
      <div class="reader-container">
        <telocity-header id="header"></telocity-header>
        <div class="viewport-wrapper">
          <div class="loading-overlay" id="loading-overlay">
            <div id="loading-text">${pageData.loadingMsg}</div>
            <div class="progress-bar-container">
              <div class="progress-bar-fill" id="loading-progress"></div>
            </div>
          </div>
          <telocity-viewport id="viewport"></telocity-viewport>
        </div>
        <telocity-navigation id="navigation"></telocity-navigation>
      </div>
      <telocity-library id="library"></telocity-library>
    `;

    this.header = /** @type {TelocityHeader | null} */ (
      this.shadowRoot.getElementById("header")
    );
    this.viewport = /** @type {TelocityViewport | null} */ (
      this.shadowRoot.getElementById("viewport")
    );
    this.navigation = /** @type {TelocityNavigation | null} */ (
      this.shadowRoot.getElementById("navigation")
    );
    this.library = /** @type {TelocityLibrary | null} */ (
      this.shadowRoot.getElementById("library")
    );

    this.setupOrchestrationListeners();
    this.setupKeyboardListeners();
    this.bootApp().catch((err) => console.error(err));
  }

  setupOrchestrationListeners() {
    this.addEventListener("font-size-changed", (e) => {
      const ev = /** @type {CustomEvent<{ fontSize: string }>} */ (e);
      if (this.viewport) {
        this.viewport.setAttribute("font-size", ev.detail.fontSize);
        this.requestSaveMetadata(this.viewport.currentPage);
      }
      if (this.fullText && this.viewport && this.bookId) {
        this.viewport
          .startPagination(this.bookId, this.fullText, this.lastUserOffset)
          .catch((err) => console.error(err));
      }
    });

    this.addEventListener("theme-toggle-requested", () => {
      const newTheme =
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "light"
          : "dark";
      document.documentElement.setAttribute("data-theme", newTheme);
    });

    this.addEventListener("recalc-requested", () => {
      if (this.fullText && this.viewport && this.bookId) {
        this.viewport
          .startPagination(
            this.bookId,
            this.fullText,
            this.lastUserOffset,
            true,
          )
          .catch((err) => console.error(err));
      }
    });

    this.addEventListener("library-open-requested", () => {
      if (this.library) {
        this.library.show(pageData.isCli);
      }
    });

    this.addEventListener("nav-prev-requested", () => {
      if (this.viewport && this.viewport.currentPage > 1) {
        this.viewport.goToPage(this.fullText, this.viewport.currentPage - 1);
      }
    });

    this.addEventListener("nav-next-requested", () => {
      if (!this.viewport) return;
      const maxNav = this.viewport.isPaginating
        ? this.viewport.estimatedTotalPages
        : this.viewport.totalPages;
      if (this.viewport.currentPage < maxNav) {
        this.viewport.goToPage(this.fullText, this.viewport.currentPage + 1);
      }
    });

    this.addEventListener("nav-input-submitted", (e) => {
      const ev = /** @type {CustomEvent<{ val: string }>} */ (e);
      const val = ev.detail.val;
      const locMatch =
        val.match(/^[lL](?:oc)?[ ]*([0-9]+)/i) ||
        val.match(/^loc[ ]*([0-9]+)/i);
      if (locMatch) {
        const targetGroup = locMatch[1];
        if (targetGroup && this.viewport) {
          const locNum = parseInt(targetGroup, 10);
          this.viewport.goToLocation(this.fullText, locNum);
        }
      } else if (this.viewport) {
        const pageNum = parseInt(val, 10);
        if (!isNaN(pageNum)) {
          this.viewport.goToPage(this.fullText, pageNum, true, false);
        }
      }
    });

    this.addEventListener("metadata-save-requested", (e) => {
      const ev =
        /** @type {CustomEvent<{ currentPage: number, lastUserOffset: number }>} */ (
          e
        );
      this.lastUserOffset = ev.detail.lastUserOffset;
      this.requestSaveMetadata(ev.detail.currentPage);
    });

    this.addEventListener("pagination-started", (e) => {
      const ev = /** @type {CustomEvent<{ forceRecalculate: boolean }>} */ (e);
      this.setLoading(
        true,
        ev.detail.forceRecalculate
          ? pageData.recalcProgressMsg || "Recalculating layout..."
          : pageData.reflowingMsg,
      );
    });

    this.addEventListener("pagination-progress", (e) => {
      const ev = /** @type {CustomEvent<{ percent: number }>} */ (e);
      this.updateLoadingProgress(ev.detail.percent);
    });

    this.addEventListener("pagination-finished", () => {
      this.setLoading(false);
    });

    this.addEventListener("pagination-failed", () => {
      this.setLoading(false);
      if (this.viewport) {
        const slider = this.viewport.shadowRoot?.getElementById("page-slider");
        if (slider) {
          slider.innerHTML = `<div class="page-content" style="width:100%">${pageData.contentLoadError || "Failed to load content."}</div>`;
        }
      }
    });

    this.addEventListener("seeking-page", (e) => {
      const ev = /** @type {CustomEvent<{ target: number }>} */ (e);
      this.setLoading(
        true,
        (pageData.seekingPageMsg || "Seeking page ") + ev.detail.target + "...",
      );
    });

    this.addEventListener("seeking-location", (e) => {
      const ev = /** @type {CustomEvent<{ targetLoc: number }>} */ (e);
      this.setLoading(
        true,
        (pageData.seekingPageMsg
          ? pageData.seekingPageMsg.replace("page", "L.")
          : "Seeking L. ") +
          ev.detail.targetLoc +
          "...",
      );
    });

    this.addEventListener("viewport-ui-updated", (e) => {
      const ev =
        /** @type {CustomEvent<{ currentPage: number, totalPages: number, estimatedTotalPages: number, isPaginating: boolean, pageBreaks: Uint32Array | number[], lastUserOffset: number, LOC_SCALE: number }>} */ (
          e
        );
      const d = ev.detail;
      const displayTotal = d.isPaginating
        ? d.estimatedTotalPages
        : d.totalPages;
      const totalString = (d.isPaginating ? "~" : "") + displayTotal;
      let statusText = "";

      if (d.pageBreaks && d.pageBreaks.length > 0) {
        const currentBreak = d.pageBreaks[d.currentPage - 1];
        const currentOffset = currentBreak !== undefined ? currentBreak : 0;
        const currentLoc = Math.floor(currentOffset / d.LOC_SCALE);
        statusText =
          "P. " + d.currentPage + "/" + totalString + " • L. " + currentLoc;
      }

      if (this.header) this.header.updateStatus(statusText);
      if (this.navigation) {
        this.navigation.updateUI(
          d.currentPage,
          d.totalPages,
          d.estimatedTotalPages,
          d.isPaginating,
          statusText,
        );
      }
    });

    this.addEventListener("sync-started", () => {
      this.setLoading(true, "Synchronizing current book...");
    });

    this.addEventListener("sync-failed", () => {
      this.setLoading(false);
    });

    this.addEventListener("book-deleted", (e) => {
      const ev = /** @type {CustomEvent<{ bookId: string }>} */ (e);
      if (this.bookId === ev.detail.bookId) {
        this.bookId = null;
        this.fullText = "";
        window.location.hash = "";
        if (this.viewport) {
          const slider =
            this.viewport.shadowRoot?.getElementById("page-slider");
          if (slider) slider.innerHTML = "";
        }
      }
    });
  }

  setupKeyboardListeners() {
    document.addEventListener(
      "keydown",
      (e) => {
        const activeEl =
          this.shadowRoot?.activeElement || document.activeElement;
        const shadowActive =
          activeEl && activeEl.shadowRoot
            ? activeEl.shadowRoot.activeElement
            : null;
        const isInput =
          (activeEl && activeEl.tagName === "INPUT") ||
          (shadowActive && shadowActive.tagName === "INPUT");
        if (isInput) return;

        if (!this.viewport || !this.library || !this.header || !this.navigation)
          return;

        switch (e.key) {
          case "ArrowLeft":
          case "h":
          case "H":
            e.preventDefault();
            this.viewport.goToPreviousPage();
            break;
          case "ArrowRight":
          case "l":
          case "L":
            e.preventDefault();
            this.viewport.goToNextPage();
            break;
          case " ":
            e.preventDefault();
            if (e.shiftKey) {
              this.viewport.goToPreviousPage();
            } else {
              this.viewport.goToNextPage();
            }
            break;
          case "g":
          case "G":
            if (!this.library.isOpen()) {
              e.preventDefault();
              this.navigation.focusInput();
            }
            break;
          case "o":
          case "O":
            e.preventDefault();
            if (this.library.isOpen()) {
              this.library.close();
            } else {
              this.library.show(pageData.isCli);
            }
            break;
          case "Escape":
          case "Esc":
            if (this.library.isOpen()) {
              e.preventDefault();
              this.library.close();
            }
            break;
          case "D":
            e.preventDefault();
            this.header.toggleRecalcButton();
            break;
        }
      },
      { passive: false },
    );

    /** @type {ReturnType<typeof setTimeout> | null} */
    let resizeTimer = null;
    window.addEventListener(
      "resize",
      () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (this.fullText && this.viewport && this.bookId) {
            this.viewport
              .startPagination(this.bookId, this.fullText, this.lastUserOffset)
              .catch((err) => console.error(err));
          }
        }, 250);
      },
      { passive: true },
    );

    window.addEventListener("hashchange", async () => {
      const hash = window.location.hash.slice(1);
      if (hash && hash !== this.bookId) {
        this.setLoading(true);
        await this.fallbackToLocal();
      }
    });
  }

  async bootApp() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("cli") === "true" && pageData.hasActiveBook) {
      this.setLoading(true, "Connecting to CLI...");
      try {
        const res = await fetch("/api/current", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const remoteLength = data.content.length;

          const existing = await getBookContent(data.bookId);
          if (!existing || existing.content.length !== remoteLength) {
            await saveBookContent(data.bookId, data.title, data.content);
          }

          this.bookId = data.bookId;
          this.fullText = data.content;
          this.bookTitle = data.title;

          history.replaceState(null, "", "#" + this.bookId);
          if (this.header)
            this.header.setAttribute("book-title", this.bookTitle);
          document.title = this.bookTitle;

          await this.initializeReader();
          return;
        }
      } catch (e) {
        console.warn("CLI fetch failed, falling back to local storage.", e);
      }
    }
    await this.fallbackToLocal();
  }

  async fallbackToLocal() {
    const hash = window.location.hash.slice(1);
    if (hash) {
      this.setLoading(true);
      const book = await getBookContent(hash);
      if (book) {
        this.bookId = hash;
        this.fullText = book.content;
        this.bookTitle = book.title;
        if (this.header) this.header.setAttribute("book-title", this.bookTitle);
        document.title = this.bookTitle;
        await this.initializeReader();
        return;
      }
    }
    this.setLoading(false);
    if (this.library) this.library.show(pageData.isCli);
  }

  async initializeReader() {
    if (!this.header || !this.viewport || !this.bookId) return;
    try {
      this.setLoading(true);

      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }

      let targetOffset = 0;
      const meta = await getMetadata(this.bookId);
      if (meta) {
        if (meta.lastFontSize) {
          this.header.setFontSize(meta.lastFontSize);
          this.viewport.setAttribute("font-size", meta.lastFontSize);
        }
        if (meta.lastCharacterOffset !== undefined) {
          targetOffset = meta.lastCharacterOffset;
          this.lastUserOffset = meta.lastCharacterOffset;
        } else if (meta.lastPage) {
          targetOffset = (meta.lastPage - 1) * 2000;
          this.lastUserOffset = targetOffset;
        }
        this.requestSaveMetadata(meta.lastPage || 1);
      }

      const fontSelector = /** @type {HTMLSelectElement | null} */ (
        this.header.shadowRoot?.getElementById("font-size-selector")
      );
      const currentFontSize = fontSelector ? fontSelector.value : "1.0rem";
      this.viewport.setAttribute("font-size", currentFontSize);

      await this.viewport.startPagination(
        this.bookId,
        this.fullText,
        targetOffset,
      );
    } catch (err) {
      console.error("Failed to initialize reader:", err);
      const slider = this.viewport.shadowRoot?.getElementById("page-slider");
      if (slider) {
        slider.innerHTML = `<div class="page-content" style="width:100%">${pageData.contentLoadError || "Failed to load content."}</div>`;
      }
      this.setLoading(false);
    }
  }

  /**
   * @param {number} pageVal
   */
  requestSaveMetadata(pageVal) {
    if (this.metaSaveTimer) clearTimeout(this.metaSaveTimer);
    this.metaSaveTimer = setTimeout(() => {
      if (!this.header || !this.bookId) return;
      const fontSelector = /** @type {HTMLSelectElement | null} */ (
        this.header.shadowRoot?.getElementById("font-size-selector")
      );
      const fontSize = fontSelector ? fontSelector.value : "1.0rem";
      saveMetadata(this.bookId, pageVal, fontSize, this.lastUserOffset).catch(
        (err) => console.error(err),
      );
    }, 1000);
  }

  /**
   * @param {boolean} isLoading
   * @param {string} [text]
   */
  setLoading(isLoading, text = pageData.loadingMsg) {
    if (!this.shadowRoot) return;
    const overlay = this.shadowRoot.getElementById("loading-overlay");
    if (overlay) overlay.classList.toggle("visible", isLoading);

    const loadingText = this.shadowRoot.getElementById("loading-text");
    if (loadingText) loadingText.textContent = text;

    const progress = this.shadowRoot.getElementById("loading-progress");
    if (progress) {
      progress.style.width = isLoading ? "0%" : "100%";
    }
  }

  /**
   * @param {number} percent
   */
  updateLoadingProgress(percent) {
    if (!this.shadowRoot) return;
    const progress = this.shadowRoot.getElementById("loading-progress");
    if (progress) progress.style.width = percent + "%";
  }
}
customElements.define("telocity-reader", TelocityReader);

document.addEventListener("DOMContentLoaded", () => {
  const systemPrefersDark = window.matchMedia(
    "(prefers-color-scheme: dark)",
  ).matches;
  document.documentElement.setAttribute(
    "data-theme",
    systemPrefersDark ? "dark" : "light",
  );
});
