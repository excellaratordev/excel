(() => {
  'use strict';

  const DB_NAME = 'superexcel-collaboration-v1';
  const DB_VERSION = 1;
  const STORE_NAME = 'outbox';
  const fallback = new Map();
  let databasePromise = null;

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: 'op_id' });
        if (!store.indexNames.contains('workbook_id')) store.createIndex('workbook_id', 'workbook_id', { unique: false });
        if (!store.indexNames.contains('created_at')) store.createIndex('created_at', 'created_at', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Não foi possível abrir a fila local.'));
      request.onblocked = () => reject(new Error('A atualização da fila local foi bloqueada por outra aba.'));
    }).catch(error => {
      console.warn('IndexedDB indisponível; usando fila temporária em memória.', error);
      return null;
    });

    return databasePromise;
  }

  function complete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Erro na fila local.'));
      transaction.onabort = () => reject(transaction.error || new Error('Operação local cancelada.'));
    });
  }

  function clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  async function put(operation) {
    const database = await openDatabase();
    if (!database) {
      fallback.set(operation.op_id, clone(operation));
      return operation;
    }
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(operation);
    await complete(transaction);
    return operation;
  }

  async function list(workbookId, limit = 100) {
    const numericWorkbookId = Number(workbookId);
    const database = await openDatabase();
    if (!database) {
      return [...fallback.values()]
        .filter(operation => Number(operation.workbook_id) === numericWorkbookId)
        .sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0))
        .slice(0, limit);
    }

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const index = transaction.objectStore(STORE_NAME).index('workbook_id');
      const request = index.openCursor(IDBKeyRange.only(numericWorkbookId));
      const result = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || result.length >= limit) {
          result.sort((left, right) => Number(left.created_at || 0) - Number(right.created_at || 0));
          resolve(result.slice(0, limit));
          return;
        }
        result.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('Não foi possível ler a fila local.'));
    });
  }

  async function remove(opIds) {
    const ids = [...new Set((opIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    const database = await openDatabase();
    if (!database) {
      ids.forEach(id => fallback.delete(id));
      return;
    }
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    ids.forEach(id => store.delete(id));
    await complete(transaction);
  }

  async function count(workbookId) {
    const numericWorkbookId = Number(workbookId);
    const database = await openDatabase();
    if (!database) {
      return [...fallback.values()].filter(operation => Number(operation.workbook_id) === numericWorkbookId).length;
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).index('workbook_id').count(IDBKeyRange.only(numericWorkbookId));
      request.onsuccess = () => resolve(Number(request.result || 0));
      request.onerror = () => reject(request.error || new Error('Não foi possível contar a fila local.'));
    });
  }

  window.SuperExcelOperationStore = Object.freeze({
    ready: openDatabase(),
    put,
    list,
    remove,
    count,
  });
})();