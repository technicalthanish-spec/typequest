const DB_NAME = "typequest-local-db";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is unavailable in this browser."));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("app")) db.createObjectStore("app");
    };
    req.onsuccess = () => {
      const db = req.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(new Error(req.error?.message || "Browser storage could not be opened."));
    req.onblocked = () => {
      blocked = true;
      reject(new Error("Browser storage is blocked by another tab. Close other TypeQuest tabs and try again."));
    };
  });
}

async function transact(mode, operation) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("app", mode);
      const req = operation(tx.objectStore("app"));
      // A successful request can still be rolled back. Wait for transaction commit.
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(new Error(tx.error?.message || "Local storage operation failed."));
      tx.onabort = () => reject(new Error(tx.error?.message || "Local storage operation was aborted."));
    });
  } finally {
    db.close();
  }
}

export const dbGet = key => transact("readonly", store => store.get(key));
export const dbSet = (key, value) => transact("readwrite", store => store.put(value, key));
export const dbClear = () => transact("readwrite", store => store.clear());
