interface Entry { key: string; text: string; created: number }
const TTL = 14 * 86400_000;
const LIMIT = 1500;
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open("bilingual-reader", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("translations", { keyPath: "key" }).createIndex("created", "created");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function cacheGet(key: string): Promise<string | undefined> {
  const database = await db();
  const entry: Entry | undefined = await result(database.transaction("translations").objectStore("translations").get(key));
  return entry && Date.now() - entry.created < TTL ? entry.text : undefined;
}
export async function cachePut(key: string, text: string): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("translations", "readwrite");
    tx.objectStore("translations").put({ key, text, created: Date.now() } satisfies Entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function cacheClear(): Promise<void> {
  const database = await db();
  await result(database.transaction("translations", "readwrite").objectStore("translations").clear());
}
export async function cacheStats(): Promise<{ count: number }> {
  const database = await db();
  return { count: await result(database.transaction("translations").objectStore("translations").count()) };
}
export async function pruneCache(): Promise<void> {
  const database = await db();
  const count = (await cacheStats()).count;
  await new Promise<void>((resolve, reject) => {
    let excess = Math.max(0, count - LIMIT);
    const tx = database.transaction("translations", "readwrite");
    const request = tx.objectStore("translations").index("created").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (excess > 0 || Date.now() - (cursor.value as Entry).created > TTL) {
        cursor.delete(); excess--; cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
