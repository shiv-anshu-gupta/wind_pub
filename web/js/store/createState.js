class BatchNotifier {
  constructor(listeners, enabled = true) {
    this._listeners = listeners;
    this._enabled = enabled;
    this._queue = [];
    this._batching = false;
    this._rafId = null;
  }

  notify(change) {
    if (this._enabled) {
      this._queue.push(change);
      if (!this._batching) {
        this._batching = true;
        this._rafId = requestAnimationFrame(() => {
          const queue = this._queue;
          this._queue = [];
          this._batching = false;
          this._rafId = null;
          for (const fn of this._listeners) {
            for (const ch of queue) {
              fn(ch);
            }
          }
        });
      }
    } else {
      for (const fn of this._listeners) {
        fn(change);
      }
    }
  }

  cancel() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._queue = [];
    this._batching = false;
  }
}

class HistoryManager {
  constructor(storageKey = "__uplot_history__") {
    this._storageKey = storageKey;
    this._history = [];
    this._redoStack = [];
    this._suppressed = false;
    this._saveTimer = null;
    this._relevantKeys = new Set([
      "yLabels",
      "lineColors",
      "yUnits",
      "axesScales",
      "xLabel",
      "xUnit",
      "title",
      "scales",
      "verticalLinesX",
      "analog",
      "digital",
    ]);
    this._loadFromStorage();
  }

  _loadFromStorage() {
    try {
      const saved = localStorage.getItem(this._storageKey);
      if (saved) {
        this._history = JSON.parse(saved);
      }
    } catch (e) {
      console.warn("[HistoryManager] Failed to load history", e);
    }
  }

  _saveToStorage() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        localStorage.setItem(this._storageKey, JSON.stringify(this._history));
      } catch (e) {
        console.warn("[HistoryManager] Failed to save history", e);
      }
    }, 100);
  }

  _detectActionType(change) {
    const pathStr = change.path.join(".");
    if (pathStr.includes("lineColors")) return "color_change";
    if (pathStr.includes("title")) return "title_change";
    if (pathStr.includes("data")) return "data_change";
    if (pathStr.includes("channels")) return "channel_update";
    return "state_update";
  }

  _isRelevantChange(change) {
    return (change.path || []).some((p) => this._relevantKeys.has(p));
  }

  add(change) {
    if (this._suppressed) return;
    if (!this._isRelevantChange(change)) return;
    const entry = {
      path: change.path,
      oldValue: change.oldValue,
      newValue: change.newValue,
      timestamp: Date.now(),
      actionType: this._detectActionType(change),
    };
    this._history.push(entry);
    this._redoStack.length = 0;
    this._saveToStorage();
  }

  getHistory() {
    return [...this._history];
  }

  clear() {
    this._history = [];
    this._saveToStorage();
  }

  suspend() {
    this._suppressed = true;
  }

  resume() {
    this._suppressed = false;
  }

  isSuppressed() {
    return this._suppressed;
  }

  withoutHistory(fn) {
    const prev = this._suppressed;
    this._suppressed = true;
    try {
      return fn();
    } finally {
      this._suppressed = prev;
    }
  }

  popForUndo() {
    const entry = this._history.pop();
    if (entry) {
      this._redoStack.push(entry);
      this._saveToStorage();
    }
    return entry;
  }

  restoreEntry(entry) {
    this._history.push(entry);
    this._redoStack.pop();
  }

  popForRedo() {
    return this._redoStack.pop();
  }

  restoreRedoEntry(entry) {
    this._redoStack.push(entry);
  }

  addAfterRedo(entry) {
    this._history.push(entry);
    this._saveToStorage();
  }

  getRedoStack() {
    return [...this._redoStack];
  }
}

class MiddlewareManager {
  constructor() {
    this._middlewares = [];
  }

  use(middleware) {
    this._middlewares.push(middleware);
  }

  apply(change) {
    let ch = change;
    for (const mw of this._middlewares) {
      ch = mw(ch) || ch;
    }
    return ch;
  }
}

class ProxyFactory {
  constructor(listeners, notifier, middleware, history) {
    this._listeners = listeners;
    this._notifier = notifier;
    this._middleware = middleware;
    this._history = history;
    this._rootProxy = null;
  }

  setRootProxy(proxy) {
    this._rootProxy = proxy;
  }

  _isObject(val) {
    return val && typeof val === "object";
  }

  _isMap(val) {
    return val instanceof Map;
  }

  createDeepProxy(target, path = []) {
    if (this._isMap(target)) {
      return this._createMapProxy(target, path);
    }
    return this._createObjectProxy(target, path);
  }

  _createMapProxy(target, path) {
    const self = this;
    return new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === "__isReactive") return true;
        if (prop === "asArray") {
          return () => Array.from(obj.entries());
        }

        if (["set", "delete", "clear"].includes(prop)) {
          return function (...args) {
            let oldValue, key;
            if (prop === "set") {
              key = args[0];
              oldValue = obj.get(key);
              let value = args[1];
              if (self._isObject(value) && !value?.__isReactive) {
                value = self.createDeepProxy(value, path.concat([key]));
                args[1] = value;
              }
              const result = Map.prototype.set.apply(obj, args);
              self._listeners.forEach((fn) =>
                fn({
                  path: path.concat([key]),
                  newValue: obj.get(key),
                  oldValue,
                  prop: key,
                  root: self._rootProxy,
                })
              );
              return result;
            } else if (prop === "delete") {
              key = args[0];
              oldValue = obj.get(key);
              const result = Map.prototype.delete.apply(obj, args);
              self._listeners.forEach((fn) =>
                fn({
                  path: path.concat([key]),
                  newValue: undefined,
                  oldValue,
                  prop: key,
                  root: self._rootProxy,
                })
              );
              return result;
            } else if (prop === "clear") {
              const oldEntries = Array.from(obj.entries());
              const result = Map.prototype.clear.apply(obj, args);
              oldEntries.forEach(([key, oldValue]) => {
                self._listeners.forEach((fn) =>
                  fn({
                    path: path.concat([key]),
                    newValue: undefined,
                    oldValue,
                    prop: key,
                    root: self._rootProxy,
                  })
                );
              });
              return result;
            }
          };
        }

        const value = Reflect.get(obj, prop, receiver);
        if (typeof prop === "string" && obj.has(prop)) {
          const v = obj.get(prop);
          if (self._isObject(v) && !v?.__isReactive) {
            const proxied = self.createDeepProxy(v, path.concat([prop]));
            obj.set(prop, proxied);
            return proxied;
          }
        }
        return value;
      },
    });
  }

  _createObjectProxy(target, path) {
    const self = this;
    return new Proxy(target, {
      set(obj, prop, value) {
        const oldValue = obj[prop];
        if (self._isObject(value) && !value?.__isReactive) {
          value = self.createDeepProxy(value, path.concat(prop));
        }
        obj[prop] = value;
        const change = self._middleware.apply({
          path: path.concat(prop),
          newValue: value,
          oldValue,
          prop,
          root: self._rootProxy,
        });
        self._notifier.notify(change);
        self._history.add(change);
        return true;
      },

      get(obj, prop) {
        if (prop === "__isReactive") return true;
        if (prop === "asArray") {
          return () => (Array.isArray(obj) ? Array.from(obj) : obj);
        }
        const value = obj[prop];
        if (self._isObject(value) && !value?.__isReactive) {
          obj[prop] = self.createDeepProxy(value, path.concat(prop));
          return obj[prop];
        }
        return value;
      },
    });
  }
}

class SubscriptionManager {
  constructor(listeners, proxy) {
    this._listeners = listeners;
    this._proxy = proxy;
  }

  setProxy(proxy) {
    this._proxy = proxy;
  }

  subscribe(fn, options) {
    let wrapped = fn;
    let pathArr, descendants, selector;
    if (typeof options === "string" || Array.isArray(options)) {
      pathArr = Array.isArray(options) ? options : options.split(".");
    } else if (typeof options === "object" && options) {
      if (options.path) {
        pathArr = Array.isArray(options.path)
          ? options.path
          : options.path.split(".");
      }
      descendants = !!options.descendants;
      selector = options.selector;
    }

    if (pathArr) {
      wrapped = (change) => {
        if (
          (descendants && pathArr.every((k, i) => k === change.path[i])) ||
          (!descendants &&
            change.path.length === pathArr.length &&
            change.path.every((k, i) => k === pathArr[i]))
        ) {
          try {
            fn(change);
          } catch (e) {
            console.error("Subscriber error:", e);
          }
        }
      };
    } else if (selector) {
      let lastValue = selector(this._proxy);
      wrapped = (change) => {
        const newValue = selector(this._proxy);
        if (newValue !== lastValue) {
          lastValue = newValue;
          try {
            fn({ ...change, selectorValue: newValue });
          } catch (e) {
            console.error("Subscriber error:", e);
          }
        }
      };
    } else {
      wrapped = (change) => {
        try {
          fn(change);
        } catch (e) {
          console.error("Subscriber error:", e);
        }
      };
    }

    this._listeners.add(wrapped);
    fn._wrappedListener = wrapped;
  }

  unsubscribe(fn) {
    this._listeners.delete(fn._wrappedListener || fn);
  }
}

class ComputedManager {
  constructor(proxy, subscriptions) {
    this._proxy = proxy;
    this._subscriptions = subscriptions;
  }

  setProxy(proxy) {
    this._proxy = proxy;
  }

  computed(name, deps, computeFn) {
    let value = computeFn(this._proxy);
    Object.defineProperty(this._proxy, name, {
      get: () => value,
      enumerable: true,
      configurable: true,
    });
    deps.forEach((depPath) => {
      this._subscriptions.subscribe(() => {
        value = computeFn(this._proxy);
      }, depPath);
    });
  }
}

class DOMBindingManager {
  constructor(proxy, subscriptions) {
    this._proxy = proxy;
    this._subscriptions = subscriptions;
  }

  setProxy(proxy) {
    this._proxy = proxy;
  }

  _isMap(val) {
    return val instanceof Map;
  }

  _getByPath(obj, path) {
    return path.reduce((o, key) => {
      if (this._isMap(o)) return o.get(key);
      return o ? o[key] : undefined;
    }, obj);
  }

  _setByPath(obj, path, value) {
    let o = obj;
    for (let i = 0; i < path.length - 1; i++) {
      o = this._isMap(o) ? o.get(path[i]) : o[path[i]];
    }
    if (this._isMap(o)) {
      o.set(path[path.length - 1], value);
    } else {
      o[path[path.length - 1]] = value;
    }
  }

  bindToDOM(propertyPath, selectorOrElement, options = {}) {
    let {
      twoWay = false,
      eventType,
      prop,
      attr,
      selectiveUpdate = false,
    } = options;
    const pathArr = Array.isArray(propertyPath)
      ? propertyPath
      : typeof propertyPath === "string"
      ? propertyPath.split(".")
      : [propertyPath];

    let el =
      typeof selectorOrElement === "string"
        ? document.querySelector(selectorOrElement)
        : selectorOrElement;

    if (!el) {
      console.warn(
        `[DOMBindingManager] bindToDOM: Element not found for selector:`,
        selectorOrElement
      );
      return;
    }

    const updateDOM = () => {
      let value = this._getByPath(this._proxy, pathArr);
      if (prop) {
        el[prop] = value ?? "";
      } else if (attr) {
        if (value == null) el.removeAttribute(attr);
        else el.setAttribute(attr, value);
      } else if (el.type === "checkbox") {
        el.checked = !!value;
      } else if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT"
      ) {
        el.value = value ?? "";
      } else {
        el.textContent = value ?? "";
      }
    };
    let updateQueue = null;
    if (selectiveUpdate) {
      if (selectiveUpdate.queue) {
        updateQueue = selectiveUpdate.queue;
      } else {
        try {
          if (typeof window !== "undefined" && window._domUpdateQueue) {
            updateQueue = window._domUpdateQueue;
          } else {
            console.warn(
              "[DOMBindingManager] selectiveUpdate enabled but domUpdateQueue not initialized globally."
            );
            selectiveUpdate = false;
          }
        } catch (e) {
          console.warn("[DOMBindingManager] selectiveUpdate fallback error:", e.message);
          selectiveUpdate = false;
        }
      }
    }

    updateDOM();
    const listener = (change) => {
      if (
        change.path.length === pathArr.length &&
        change.path.every((k, i) => k === pathArr[i])
      ) {
        if (
          selectiveUpdate &&
          updateQueue &&
          updateQueue.isActive &&
          updateQueue.isActive()
        ) {
          const dedupeKey = `${
            el.id || el.className || el.tagName
          }_${pathArr.join(".")}`;
          updateQueue.queueUpdate({
            element: el,
            updateFn: updateDOM,
            dedupeKey,
          });
        } else {
          updateDOM();
        }
      }
    };
    this._subscriptions.subscribe(listener);
    if (twoWay) {
      let readProp = prop;
      let evt =
        eventType ||
        (el.type === "checkbox"
          ? "change"
          : el.tagName === "SELECT"
          ? "change"
          : "input");

      const handler = (e) => {
        let val;
        if (attr) {
          val = el.getAttribute(attr);
        } else if (readProp) {
          val = el[readProp];
        } else if (el.type === "checkbox") {
          val = el.checked;
        } else {
          val = el.value;
        }
        this._setByPath(this._proxy, pathArr, val);
      };
      el.addEventListener(evt, handler);
      return () => {
        this._subscriptions.unsubscribe(listener);
        el.removeEventListener(evt, handler);
        updateQueue = null;
      };
    } else {
      return () => {
        this._subscriptions.unsubscribe(listener);
        updateQueue = null;
      };
    }
  }
}

class ReactiveState {
  constructor(initialState, { batch = true } = {}) {
    this._batch = batch;
    this._listeners = new Set();
    this._notifier = new BatchNotifier(this._listeners, batch);
    this._middleware = new MiddlewareManager();
    this._history = new HistoryManager();
    this._proxyFactory = new ProxyFactory(
      this._listeners,
      this._notifier,
      this._middleware,
      this._history
    );
    const root =
      initialState === null || typeof initialState !== "object"
        ? { value: initialState }
        : initialState;

    this._proxy = this._proxyFactory.createDeepProxy(root);
    this._proxyFactory.setRootProxy(this._proxy);
    this._subscriptions = new SubscriptionManager(this._listeners, this._proxy);
    this._computed = new ComputedManager(this._proxy, this._subscriptions);
    this._domBinding = new DOMBindingManager(this._proxy, this._subscriptions);
    this._attachProxyMethods();
  }

  _attachProxyMethods() {
    const proxy = this._proxy;
    proxy.subscribe = (fn, options) => this._subscriptions.subscribe(fn, options);
    proxy.unsubscribe = (fn) => this._subscriptions.unsubscribe(fn);
    proxy.use = (mw) => this._middleware.use(mw);
    proxy.computed = (name, deps, computeFn) =>
      this._computed.computed(name, deps, computeFn);
    proxy.derived = proxy.computed; 

    proxy.bindToDOM = (propertyPath, selectorOrElement, options) =>
      this._domBinding.bindToDOM(propertyPath, selectorOrElement, options);

    proxy.getHistory = () => this._history.getHistory();
    proxy.clearHistory = () => this._history.clear();
    proxy.suspendHistory = () => this._history.suspend();
    proxy.resumeHistory = () => this._history.resume();
    proxy.withoutHistory = (fn) => this._history.withoutHistory(fn);
    proxy.getRedoStack = () => this._history.getRedoStack();
    proxy.undoLast = () => this._undoLast();
    proxy.redoLast = () => this._redoLast();
  }

  _undoLast() {
    const entry = this._history.popForUndo();
    if (!entry) return;
    try {
      let target = this._proxy;
      for (let i = 0; i < entry.path.length - 1; i++) {
        const k = entry.path[i];
        if (target == null || typeof target !== "object") {
          this._history.restoreEntry(entry);
          return;
        }
        target = target[k];
      }

      const key = entry.path[entry.path.length - 1];
      this._history.suspend();
      target[key] = entry.oldValue;
      this._history.resume();
    } catch (err) {
      console.error("[ReactiveState] undoLast failed:", err);
      try {
        this._history.restoreEntry(entry);
      } catch (_) {}
    }
  }

  _redoLast() {
    const entry = this._history.popForRedo();
    if (!entry) return;
    try {
      let target = this._proxy;
      for (let i = 0; i < entry.path.length - 1; i++) {
        const k = entry.path[i];
        if (target == null || typeof target !== "object") {
          this._history.restoreRedoEntry(entry);
          return;
        }
        target = target[k];
      }

      const key = entry.path[entry.path.length - 1];
      this._history.suspend();
      target[key] = entry.newValue;
      this._history.resume();
      this._history.addAfterRedo(entry);
    } catch (err) {
      console.error("[ReactiveState] redoLast failed:", err);
      try {
        this._history.restoreRedoEntry(entry);
      } catch (_) {}
    }
  }

  getProxy() {
    return this._proxy;
  }

  getListeners() {
    return this._listeners;
  }

  getHistoryManager() {
    return this._history;
  }

  getMiddlewareManager() {
    return this._middleware;
  }

  getSubscriptionManager() {
    return this._subscriptions;
  }
}

export function createState(initialState, options = {}) {
  const stateManager = new ReactiveState(initialState, options);
  return stateManager.getProxy();
}

export function unwrap(valOrState) {
  if (valOrState && typeof valOrState === "object" && "value" in valOrState) {
    return valOrState.value;
  }
  return valOrState;
}

export { ReactiveState };

export {
  BatchNotifier,
  HistoryManager,
  MiddlewareManager,
  ProxyFactory,
  SubscriptionManager,
  ComputedManager,
  DOMBindingManager,
};
