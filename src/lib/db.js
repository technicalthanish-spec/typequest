const DB_NAME = "typequest-local-db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable in this browser."));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("app")) db.createObjectStore("app");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new Error(req.error?.message || "Browser storage could not be opened."));
    req.onblocked = () => reject(new Error("Browser storage is blocked by another tab. Close other TypeQuest tabs and try again."));
  });
}

export async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("app", "readonly");
      const req = tx.objectStore("app").get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(req.error?.message || "Could not read local progress."));
      tx.onerror = () => reject(new Error(tx.error?.message || "Could not read local progress."));
    } catch (e) { reject(e); }
  });
}

export async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("app", "readwrite");
      tx.objectStore("app").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(tx.error?.message || "Could not save local progress."));
      tx.onabort = () => reject(new Error(tx.error?.message || "Saving local progress was aborted."));
    } catch (e) { reject(e); }
  });
}

export async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("app", "readwrite");
      tx.objectStore("app").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(tx.error?.message || "Could not reset local progress."));
      tx.onabort = () => reject(new Error(tx.error?.message || "Resetting local progress was aborted."));
    } catch (e) { reject(e); }
  });
}
