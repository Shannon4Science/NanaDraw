/**
 * IndexedDB-backed diagram storage.
 *
 * localStorage has a ~5 MB limit which is easily exceeded by diagrams
 * containing base64-encoded component images. IndexedDB supports
 * hundreds of MB and is available in all modern browsers.
 */

const DB_NAME = "nanadraw";
const DB_VERSION = 2;
const STORE_NAME = "diagrams";
const KEY = "current_xml";
const LS_KEY = "nanadraw_diagram_xml";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1) {
        db.createObjectStore(STORE_NAME);
      }
      if (oldVersion < 2 && !db.objectStoreNames.contains("ppt_slides")) {
        // v2 schema upgrade placeholder – kept for IndexedDB version compatibility
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function saveDiagramXml(xml: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(xml, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadDiagramXml(): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function removeDiagramXml(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * One-time migration: move data from localStorage to IndexedDB,
 * then clear the localStorage entry to free space.
 */
export async function migrateFromLocalStorage(): Promise<string | null> {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      await saveDiagramXml(saved);
      localStorage.removeItem(LS_KEY);
      return saved;
    }
  } catch {
    // localStorage may not be accessible
  }
  return null;
}
