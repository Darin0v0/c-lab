/**
 * Student - CodeMirror C++ Editor
 */

(function () {
  let studentId = null;
  let editorInstance = null;
  let compilerInstance = null;
  let codeEditor = null;
  let codeSyncTimer = null;
  let lastSavedAt = 0;
  let isLoggingOut = false;
  let didSendUnloadEvent = false;
  let lastWindowActivity = { type: "", at: 0 };
  let antiCheatLockUntil = 0;
  let antiCheatLockTimer = null;
  let antiCheatCooldownWindow = [];
  let antiCheatListenerBound = false;
  let antiCheatDevtoolsWarnAt = 0;
  let bypassMonitorTimer = null;
  let bypassReportWindow = {};
  let secureViewportOk = true;
  let lastViewportStrikeAt = 0;
  let fullscreenPromptBound = false;

  function getSocket() {
    return Compiler.getSocket();
  }

  const STORAGE_KEY = "student_info";
  const CODE_STORAGE_KEY = "student_code";
  const UI_PREFS_KEY = "student_ui_prefs_v1";
  const ANTI_CHEAT = {
    windowMs: 120000,
    softLockThreshold: 6,
    hardLockThreshold: 10,
    softLockMs: 60000,
    hardLockMs: 180000
  };
  const ALLOWED_ACTIVITY_TYPES = new Set([
    "view", "run", "compile", "blur_window", "focus", "logout",
    "copy", "paste", "right_click", "suspicious", "unload", "task_received", "message_received"
  ]);

  function trimText(value, max = 200) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
  }

  function normalizeActivityType(type) {
    const safeType = trimText(String(type || ""), 32);
    if (!ALLOWED_ACTIVITY_TYPES.has(safeType)) return "suspicious";
    return safeType;
  }

  function normalizeActivityDetails(details) {
    if (!details || typeof details !== "object" || Array.isArray(details)) return {};
    const safe = {};
    const entries = Object.entries(details).slice(0, 12);
    for (const [keyRaw, value] of entries) {
      const key = trimText(String(keyRaw || ""), 40);
      if (!key) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        safe[key] = value;
        continue;
      }
      if (typeof value === "boolean") {
        safe[key] = value;
        continue;
      }
      safe[key] = trimText(String(value ?? ""), 300);
    }
    return safe;
  }

  function detectPlatform() {
    try {
      if (navigator.userAgentData?.platform) return String(navigator.userAgentData.platform).toLowerCase();
      if (navigator.platform) return String(navigator.platform).toLowerCase();
      if (navigator.userAgent) {
        const ua = String(navigator.userAgent).toLowerCase();
        if (ua.includes("linux")) return "linux";
        if (ua.includes("win")) return "windows";
        if (ua.includes("mac")) return "mac";
        return ua.slice(0, 60);
      }
    } catch (e) {}
    return "unknown";
  }

  function sendActivityBeacon(payload) {
    if (!navigator.sendBeacon || !payload?.studentId || !payload?.activity) return;
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      navigator.sendBeacon("/api/activities", blob);
    } catch (e) {}
  }

  function reportWindowActivity(type, source, extra = {}) {
    const normalizedType = normalizeActivityType(type);
    const now = Date.now();
    if (lastWindowActivity.type === normalizedType && now - lastWindowActivity.at < 900) return;
    lastWindowActivity = { type: normalizedType, at: now };
    addActivity(normalizedType, {
      source: trimText(source || "unknown", 48),
      platform: detectPlatform(),
      ...extra
    });
  }

  function getCopiedTextFromEvent(e) {
    let text = "";
    try {
      const active = document.activeElement;
      if (active && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && typeof active.value === "string"))) {
        const start = Number.isInteger(active.selectionStart) ? active.selectionStart : 0;
        const end = Number.isInteger(active.selectionEnd) ? active.selectionEnd : 0;
        if (end > start) {
          text = String(active.value || "").slice(start, end);
        }
      }
    } catch (err) {}

    if (!text) {
      try {
        text = window.getSelection?.()?.toString?.() || "";
      } catch (err) {}
    }

    if (!text) {
      try {
        text = e?.clipboardData?.getData?.("text/plain") || "";
      } catch (err) {}
    }

    return String(text || "");
  }

  function isAntiCheatLocked() {
    return Date.now() < antiCheatLockUntil;
  }

  function updateSecurityState() {
    window.StudentSecurity = {
      isLocked: isAntiCheatLocked(),
      secureViewport: !!secureViewportOk,
      canRun: !isAntiCheatLocked() && !!secureViewportOk
    };
  }

  function setActionControlsLocked(locked) {
    const runBtn = document.getElementById("runBtn");
    const runBtn2 = document.getElementById("runBtn2");
    const terminalInput = document.getElementById("terminalInput");

    if (runBtn) runBtn.disabled = !!locked;
    if (runBtn2) runBtn2.disabled = !!locked;
    if (terminalInput) terminalInput.disabled = !!locked;

    if (codeEditor) {
      try {
        codeEditor.setOption("readOnly", locked ? "nocursor" : false);
      } catch (e) {}
    }
    updateSecurityState();
  }

  function scheduleLockRelease() {
    if (antiCheatLockTimer) {
      clearTimeout(antiCheatLockTimer);
      antiCheatLockTimer = null;
    }
    if (!isAntiCheatLocked()) {
      setActionControlsLocked(false);
      return;
    }
    antiCheatLockTimer = setTimeout(() => {
      if (!isAntiCheatLocked()) {
        setActionControlsLocked(false);
        print("> Blokada anti-cheat zdjęta.", "system");
      } else {
        scheduleLockRelease();
      }
    }, Math.max(400, antiCheatLockUntil - Date.now()));
  }

  function applyAntiCheatLock(ms, reason) {
    const until = Date.now() + Math.max(1000, Number(ms) || ANTI_CHEAT.softLockMs);
    antiCheatLockUntil = Math.max(antiCheatLockUntil, until);
    setActionControlsLocked(true);
    scheduleLockRelease();
    print("> ANTY-CHEAT: " + (reason || "Wykryto niedozwolone zachowanie"), "error");
    print("> Edytor i uruchamianie zostały czasowo zablokowane.", "warning");
  }

  function forceLogout(reason) {
    isLoggingOut = true;
    addActivity("logout", { forcedByAntiCheat: true, reason: trimText(reason || "Anty-cheat", 160) });
    print("> ANTY-CHEAT: " + (reason || "Wymuszone wylogowanie"), "error");
    const s = getSocket();
    if (s && s.connected) {
      s.emit("student_logout", { studentId: studentId, reason: "anti_cheat_forced" });
      s.emit("student_code", { code: "" });
    }
    fetch("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: studentId })
    }).catch(() => {});
    setTimeout(() => {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(CODE_STORAGE_KEY);
      localStorage.removeItem("studentActivity");
      location.reload();
    }, 1800);
  }

  function antiCheatStrike(weight, reason, details = {}) {
    const now = Date.now();
    const safeWeight = Math.max(1, Math.min(4, Number(weight) || 1));
    antiCheatCooldownWindow = antiCheatCooldownWindow.filter((item) => now - item.ts <= ANTI_CHEAT.windowMs);
    antiCheatCooldownWindow.push({ ts: now, weight: safeWeight, reason: trimText(reason || "naruszenie", 120) });
    const score = antiCheatCooldownWindow.reduce((sum, item) => sum + item.weight, 0);

    addActivity("suspicious", {
      reason: trimText(reason || "Naruszenie zasad", 160),
      score,
      ...details
    });

    if (score >= ANTI_CHEAT.hardLockThreshold) {
      applyAntiCheatLock(ANTI_CHEAT.hardLockMs, "Zbyt wiele naruszeń w krótkim czasie.");
    } else if (score >= ANTI_CHEAT.softLockThreshold) {
      applyAntiCheatLock(ANTI_CHEAT.softLockMs, "Podejrzana aktywność.");
    }
  }

  function reportBypassAttempt(reason, details = {}) {
    const key = trimText(reason || "bypass", 80) || "bypass";
    const now = Date.now();
    if (bypassReportWindow[key] && now - bypassReportWindow[key] < 15000) return;
    bypassReportWindow[key] = now;

    antiCheatStrike(4, "Wykryto obejście zabezpieczeń: " + key, {
      guard: "integrity_monitor",
      ...details
    });

    const s = getSocket();
    if (s && s.connected) {
      s.emit("anti_cheat_bypass", {
        reason: key,
        details: normalizeActivityDetails(details),
        ts: now
      });
    }
  }

  function verifyGuardedEventBlocked(type) {
    let ev = null;
    try {
      if (type === "contextmenu") {
        ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      } else if (type === "paste") {
        ev = new Event("paste", { bubbles: true, cancelable: true });
      } else if (type === "drop") {
        ev = new Event("drop", { bubbles: true, cancelable: true });
      }
      if (!ev) return true;
      const dispatched = document.dispatchEvent(ev);
      return ev.defaultPrevented || dispatched === false;
    } catch (e) {
      return true;
    }
  }

  function startBypassProtectionMonitor() {
    if (bypassMonitorTimer) return;

    const baseline = {
      fetch: window.fetch,
      setInterval: window.setInterval,
      clearInterval: window.clearInterval,
      addEventListener: EventTarget.prototype.addEventListener,
      removeEventListener: EventTarget.prototype.removeEventListener
    };

    bypassMonitorTimer = setInterval(() => {
      try {
        if (window.fetch !== baseline.fetch) {
          reportBypassAttempt("Podmiana window.fetch");
        }
        if (window.setInterval !== baseline.setInterval || window.clearInterval !== baseline.clearInterval) {
          reportBypassAttempt("Podmiana timerów globalnych");
        }
        if (EventTarget.prototype.addEventListener !== baseline.addEventListener ||
            EventTarget.prototype.removeEventListener !== baseline.removeEventListener) {
          reportBypassAttempt("Podmiana EventTarget.prototype");
        }

        if (!verifyGuardedEventBlocked("contextmenu")) {
          reportBypassAttempt("Wyłączona blokada contextmenu");
        }
        if (!verifyGuardedEventBlocked("paste")) {
          reportBypassAttempt("Wyłączona blokada paste");
        }
        if (!verifyGuardedEventBlocked("drop")) {
          reportBypassAttempt("Wyłączona blokada drop");
        }

        if (isAntiCheatLocked()) {
          const runBtn = document.getElementById("runBtn");
          const runBtn2 = document.getElementById("runBtn2");
          if (runBtn && !runBtn.disabled) reportBypassAttempt("Run button aktywny mimo locka");
          if (runBtn2 && !runBtn2.disabled) reportBypassAttempt("Run2 button aktywny mimo locka");
          if (codeEditor) {
            let ro = false;
            try { ro = codeEditor.getOption("readOnly"); } catch (e) {}
            if (ro !== "nocursor") reportBypassAttempt("CodeMirror readOnly zdjęte podczas locka");
          }
        }
      } catch (e) {}
    }, 4000);
  }

  function bindServerAntiCheatSignals() {
    if (antiCheatListenerBound) return;
    const s = getSocket();
    if (!s) return;
    antiCheatListenerBound = true;
    s.on("anti_cheat_action", (payload) => {
      const action = trimText(String(payload?.action || "warn"), 16).toLowerCase();
      const reason = trimText(payload?.reason || "Działanie anty-cheat", 220);
      const durationMs = Number(payload?.durationMs) || ANTI_CHEAT.softLockMs;
      if (action === "lock") {
        applyAntiCheatLock(durationMs, reason);
        return;
      }
      if (action === "logout") {
        forceLogout(reason);
        return;
      }
      print("> ANTY-CHEAT (serwer): " + reason, "warning");
    });
  }

  function isViewportCoveringScreen() {
    const sw = Number(window.screen?.availWidth || window.screen?.width || 0);
    const sh = Number(window.screen?.availHeight || window.screen?.height || 0);
    if (!sw || !sh) return true;
    const ow = Number(window.outerWidth || 0);
    const oh = Number(window.outerHeight || 0);
    return ow >= sw * 0.92 && oh >= sh * 0.88;
  }

  function isExamViewportSecure() {
    const hasFullscreen = !!document.fullscreenElement;
    return hasFullscreen && isViewportCoveringScreen();
  }

  function tryEnterFullscreen(source = "auto") {
    if (document.fullscreenElement) return;
    const el = document.documentElement;
    if (!el || typeof el.requestFullscreen !== "function") return;
    el.requestFullscreen().catch(() => {
      antiCheatStrike(2, "Brak pełnego ekranu", { source });
    });
  }

  function bindFullscreenPrompt() {
    if (fullscreenPromptBound) return;
    fullscreenPromptBound = true;
    const handler = () => {
      tryEnterFullscreen("gesture");
      window.removeEventListener("pointerdown", handler, true);
      window.removeEventListener("keydown", handler, true);
    };
    window.addEventListener("pointerdown", handler, true);
    window.addEventListener("keydown", handler, true);
  }

  function enforceExamViewport(source = "interval") {
    secureViewportOk = isExamViewportSecure();
    updateSecurityState();
    if (secureViewportOk) return;

    const now = Date.now();
    if (now - lastViewportStrikeAt < 15000) return;
    lastViewportStrikeAt = now;
    antiCheatStrike(2, "Podejrzany układ okna (możliwe 2 okna)", {
      source,
      fullscreen: !!document.fullscreenElement,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    });
    applyAntiCheatLock(45000, "Wymagany pełny ekran podczas sprawdzianu.");
  }

  function generateId() {
    return "s_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  function saveStudent(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function loadStudent() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      return null;
    }
  }

  async function registerStudent(id, firstName, journalNum, className) {
    let safeFirstName = 'Uczen';
    let safeJournalNum = '';
    let safeClassName = '';
    
    if (typeof firstName === 'string' && firstName.length > 0 && firstName !== 'undefined' && firstName !== 'null') {
      safeFirstName = firstName.trim();
    }
    if (typeof journalNum === 'string' && journalNum.length > 0 && journalNum !== 'undefined' && journalNum !== 'null') {
      safeJournalNum = journalNum.trim();
    }
    if (typeof className === 'string' && className.length > 0 && className !== 'undefined' && className !== 'null') {
      safeClassName = className.trim();
    }
    
    console.log('[STUDENT] registerStudent called:', { id, firstName, journalNum, className });
    
    try {
      await fetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, firstName: safeFirstName, journalNum: safeJournalNum, className: safeClassName }),
      });
    } catch (e) {}
    
    const s = getSocket();
    if (s && s.connected) {
      console.log('[STUDENT] Wysyłam register_student:', { id, firstName: safeFirstName, journalNum: safeJournalNum, className: safeClassName });
      s.emit("register_student", { id, firstName: safeFirstName, journalNum: safeJournalNum, className: safeClassName });
    } else {
      console.log('[STUDENT] Socket nie jest połączony!', s?.connected);
    }
  }

  function addActivity(type, details) {
    if (!studentId) return;
    const saved = loadStudent();
    const studentName = (saved?.firstName && saved.firstName !== 'undefined') 
      ? saved.firstName.trim()
      : 'Nieznany';
    const entry = {
      ts: Date.now(),
      type: normalizeActivityType(type),
      details: normalizeActivityDetails(details)
    };
    let log = {};
    try {
      log = JSON.parse(localStorage.getItem("studentActivity") || "{}") || {};
    } catch (e) {
      log = {};
    }
    if (!log[studentId]) log[studentId] = [];
    log[studentId].push(entry);
    localStorage.setItem("studentActivity", JSON.stringify(log));

    const payload = {
      studentId,
      studentName: trimText(studentName, 80) || "Nieznany",
      activity: entry
    };
    
    fetch("/api/activities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: entry.type === "unload",
      body: JSON.stringify(payload),
    }).catch(() => {});
    
    const s = getSocket();
    if (s && s.connected) {
      s.emit("student_activity", { ...entry, studentName: payload.studentName });
    }

    if (entry.type === "unload") {
      sendActivityBeacon(payload);
    }
  }

  function askForName() {
    let first = "", journalNum = "", className = "";
    while (!first) {
      first = prompt("Podaj imię i nazwisko (np. Jan Kowalski):");
      if (first === null) return null;
      first = first ? first.trim() : "";
      if (!first) alert("Wpisz imię i nazwisko!");
    }
    while (!journalNum) {
      journalNum = prompt("Podaj numer w dzienniku:");
      if (journalNum === null) return null;
      journalNum = journalNum ? journalNum.trim() : "";
      if (!journalNum) alert("Wpisz numer w dzienniku!");
    }
    while (!className) {
      className = prompt("Podaj klasę (np. 3a, 2bt):");
      if (className === null) return null;
      className = className ? className.trim() : "";
      if (!className) alert("Wpisz klasę!");
    }
    return { firstName: first, journalNum: journalNum, className: className };
  }

  function initSession() {
    const saved = loadStudent();
    console.log('[STUDENT] initSession - loaded student:', saved);
    
    if (saved && saved.firstName && saved.journalNum && saved.className) {
      studentId = saved.id;
      const studentBadge = document.getElementById("studentBadge");
      if (studentBadge) studentBadge.textContent = saved.firstName + " (" + saved.className + " | nr " + saved.journalNum + ")";
      console.log('[STUDENT] Using existing session:', saved.firstName);
      return true;
    }
    
    const data = askForName();
    if (!data) return false;
    
    studentId = generateId();
    const studentData = { id: studentId, firstName: data.firstName, journalNum: data.journalNum, className: data.className };
    console.log('[STUDENT] Saving new student data:', studentData);
    saveStudent(studentData);
    
    const studentBadge = document.getElementById("studentBadge");
    if (studentBadge) studentBadge.textContent = data.firstName + " (" + data.className + " | nr " + data.journalNum + ")";
    return true;
  }

  function clearTerminal() {
    const terminalOutput = document.getElementById("terminalOutput");
    if (terminalOutput) terminalOutput.innerHTML = "";
  }

  function print(text, type) {
    const terminalOutput = document.getElementById("terminalOutput");
    if (!terminalOutput) return;
    type = type || "stdout";
    const line = document.createElement("div");
    line.className = "line " + type;
    line.textContent = text;
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  function addCursor() {
    const terminalOutput = document.getElementById("terminalOutput");
    if (!terminalOutput) return;
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    terminalOutput.appendChild(cursor);
  }

  function pushCurrentCodeSnapshot() {
    const latestCode = editorInstance?.getValue?.() || codeEditor?.getValue?.() || localStorage.getItem(CODE_STORAGE_KEY) || '';
    localStorage.setItem(CODE_STORAGE_KEY, latestCode);
    lastSavedAt = Date.now();
    updateAutosaveState("Zapisano " + formatClock(lastSavedAt), "saved");

    if (codeSyncTimer) {
      clearTimeout(codeSyncTimer);
      codeSyncTimer = null;
    }

    const s = getSocket();
    if (s?.connected) {
      s.emit("student_code", { code: latestCode });
    }

    return latestCode;
  }

  function formatClock(ts) {
    const date = new Date(ts || Date.now());
    return date.toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function updateReadyState(text) {
    const el = document.getElementById("readyState");
    if (!el) return;
    el.innerHTML = "<span>🔔</span><span>" + text + "</span>";
  }

  function updateAutosaveState(text, mode = "idle") {
    const el = document.getElementById("autosaveState");
    if (!el) return;
    el.innerHTML = "<span>" + text + "</span>";
    if (mode === "saved") el.style.color = "#8ee6a0";
    else if (mode === "saving") el.style.color = "#ffd166";
    else if (mode === "error") el.style.color = "#ff8f8f";
    else el.style.color = "";
  }

  function updateCursorAndStats() {
    if (!codeEditor) return;
    const pos = codeEditor.getCursor();
    const cursorPosEl = document.getElementById("cursorPos");
    if (cursorPosEl) {
      cursorPosEl.innerHTML = "<span>Ln " + (pos.line + 1) + ", Col " + (pos.ch + 1) + "</span>";
    }

    const code = codeEditor.getValue();
    const lines = code.length ? code.split("\n").length : 1;
    const chars = code.length;
    const codeStatsEl = document.getElementById("codeStats");
    if (codeStatsEl) {
      codeStatsEl.innerHTML = "<span>" + lines + " linii • " + chars + " znaków</span>";
    }
  }

  function loadUiPrefs() {
    try {
      const raw = localStorage.getItem(UI_PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (prefs.terminalHeight) {
        const terminalPanel = document.querySelector(".terminal-panel");
        if (terminalPanel) terminalPanel.style.height = prefs.terminalHeight;
      }
    } catch (e) {}
  }

  function saveUiPrefs() {
    try {
      const terminalPanel = document.querySelector(".terminal-panel");
      const prefs = {
        terminalHeight: terminalPanel?.style?.height || ""
      };
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {}
  }

  function initEditor() {
    const editorEl = document.getElementById('editor');
    if (!editorEl) return null;

    const savedCode = localStorage.getItem(CODE_STORAGE_KEY) || '';

    codeEditor = CodeMirror(editorEl, {
      value: savedCode,
      mode: "text/x-c++src",
      theme: "default",
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: false,
      autofocus: true,
      extraKeys: {
        "Ctrl-Space": "autocomplete",
        "Ctrl-F": "findPersistent"
      }
    });

    codeEditor.setSize("100%", "100%");

    codeEditor.on("change", function() {
      const code = codeEditor.getValue();
      localStorage.setItem(CODE_STORAGE_KEY, code);
      updateAutosaveState("Zapisywanie...", "saving");
      updateCursorAndStats();
      
      if (codeSyncTimer) clearTimeout(codeSyncTimer);
      codeSyncTimer = setTimeout(() => {
        const s = getSocket();
        if (s?.connected) {
          s.emit("compile_only", { code, jobId: "live_" + Date.now() });
          s.emit("student_code", { code });
        }
        lastSavedAt = Date.now();
        updateAutosaveState("Zapisano " + formatClock(lastSavedAt), "saved");
      }, 250);
    });

    codeEditor.on("cursorActivity", updateCursorAndStats);
    updateCursorAndStats();
    updateAutosaveState("Autosave: gotowe");

    return {
      getValue: () => codeEditor.getValue(),
      setValue: (code) => codeEditor.setValue(code),
      undo: () => codeEditor.undo(),
      redo: () => codeEditor.redo(),
      highlightError: (line) => {
        codeEditor.addLineClass(line - 1, "background", "error-line");
        codeEditor.scrollIntoView({ line: line - 1 });
      },
      clearError: () => {
        codeEditor.eachLine((line) => {
          codeEditor.removeLineClass(line, "background", "error-line");
        });
      },
      refresh: () => codeEditor.refresh()
    };
  }

  function init() {
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';
    
    if (!initSession()) return;

    const terminalOutput = document.getElementById("terminalOutput");
    const terminalInput = document.getElementById("terminalInput");
    const runBtn = document.getElementById("runBtn");
    const runBtn2 = document.getElementById("runBtn2");
    const saveBtn = document.getElementById("saveBtn");
    const clearBtn = document.getElementById("clearBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const statusBadge = document.getElementById("statusBadge");

    loadUiPrefs();
    editorInstance = initEditor();
    window.Editor = editorInstance;

    compilerInstance = Compiler.initCompiler({
      terminalOutput: terminalOutput,
      terminalInput: terminalInput,
      runBtn: runBtn,
      runBtn2: runBtn2,
      statusBadge: statusBadge
    }, {
      onActivity: addActivity,
      onConnect: () => {
        updateReadyState("Połączono");
        bindServerAntiCheatSignals();
        startBypassProtectionMonitor();
        bindFullscreenPrompt();
        enforceExamViewport("on_connect");
        console.log('[STUDENT] Socket połączony, rejestruję...');
        setTimeout(() => {
          if (studentId) {
            const saved = loadStudent();
            console.log('[STUDENT] onConnect - loaded student:', saved);
            if (saved) {
              registerStudent(studentId, saved.firstName, saved.journalNum, saved.className);
            } else {
              console.log('[STUDENT] ERROR: saved is null/undefined!');
            }
          } else {
            console.log('[STUDENT] ERROR: studentId is not set!');
          }
        }, 500);
      },
      onTaskReceived: (task) => {
        if (confirm(`Nauczyciel wyslal zadanie: "${task.title}"\n\nCzy wczytac tresc zadania do edytora?`)) {
          if (editorInstance) editorInstance.setValue(task.code);
          localStorage.setItem(CODE_STORAGE_KEY, task.code);
          updateAutosaveState("Wczytano zadanie", "idle");
        }
        addActivity("task_received", { title: task.title });
        addCursor();
      }
    });

    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        const code = editorInstance.getValue();
        const blob = new Blob([code], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "program.cpp";
        a.click();
        URL.revokeObjectURL(url);
        print("> Kod pobrany jako program.cpp", "system");
      });
    }
    
    if (clearBtn) {
      clearBtn.addEventListener("click", function() {
        clearTerminal();
        print("> Terminal wyczyszczony", "system");
        addCursor();
      });
    }
    
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function () {
        if (confirm("Wylogować się?")) {
          isLoggingOut = true;
          addActivity("logout");

          // Clear editor immediately on student side.
          try {
            if (editorInstance?.setValue) editorInstance.setValue("");
          } catch (e) {}
          localStorage.removeItem(CODE_STORAGE_KEY);

          const s = getSocket();
          if (s && s.connected) {
            s.emit("student_logout", { studentId: studentId });
            s.emit("student_code", { code: "" });
          }

          // Fallback reset path in case socket event is lost.
          fetch("/api/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentId: studentId })
          }).catch(() => {});
          
          const statusDot = document.getElementById("statusDot");
          const statusBadge = document.getElementById("statusBadge");
          if (statusDot) {
            statusDot.classList.remove("online");
            statusDot.classList.add("error");
          }
          if (statusBadge) {
            statusBadge.textContent = "Offline";
          }
          
          const terminalOutput = document.getElementById("terminalOutput");
          if (terminalOutput) {
            terminalOutput.innerHTML += "\n" + '<div class="line system" style="color: #f14c4c;">═══════════════════════════════</div>';
            terminalOutput.innerHTML += "\n" + '<div class="line system" style="color: #f14c4c; font-weight: bold;">Zostałeś wylogowany. Jesteś teraz OFFLINE.</div>';
            terminalOutput.innerHTML += "\n" + '<div class="line system" style="color: #6b7280;">Strona odświeży się automatycznie...</div>';
            terminalOutput.innerHTML += "\n" + '<div class="line system" style="color: #f14c4c;">═══════════════════════════════</div>';
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
          }
          
          setTimeout(() => {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(CODE_STORAGE_KEY);
            localStorage.removeItem("studentActivity");
            location.reload();
          }, 2000);
        }
      });
    }

    const terminalInputEl = document.getElementById("terminalInput");
    document.addEventListener("keydown", function (e) {
      if (isAntiCheatLocked()) {
        const blockedKeys = ["Enter", "F5"];
        if ((e.ctrlKey || e.metaKey) || blockedKeys.includes(e.key)) {
          e.preventDefault();
          return;
        }
      }

      if ((e.ctrlKey || e.metaKey) && ["v", "x", "a"].includes(String(e.key || "").toLowerCase())) {
        e.preventDefault();
        antiCheatStrike(2, "Próba użycia skrótu schowka", { key: String(e.key || "").toLowerCase() });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && String(e.key || "").toLowerCase() === "c") {
        antiCheatStrike(1, "Próba kopiowania skrótem", { key: "c" });
      }
      if (e.shiftKey && e.key === "Insert") {
        e.preventDefault();
        antiCheatStrike(2, "Próba wklejenia przez Shift+Insert");
        return;
      }
      if (e.key === "F12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c"].includes(String(e.key || "").toLowerCase()))) {
        e.preventDefault();
        antiCheatStrike(3, "Próba otwarcia DevTools", { key: String(e.key || "") });
        return;
      }

      const isTypingInInput = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        const code = editorInstance?.getValue?.() || localStorage.getItem(CODE_STORAGE_KEY) || "";
        Compiler.runCode(code);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        clearTerminal();
        print("> Terminal wyczyszczony", "system");
        addCursor();
        return;
      }
      if (e.key === "Escape") {
        const terminalFocused = document.activeElement === terminalInputEl;
        if (!isTypingInInput || terminalFocused) {
          if (compilerInstance?.isRunning?.()) {
            e.preventDefault();
            Compiler.stopProgram();
            print("> Program zatrzymany (Esc)", "warning");
          }
        }
      }
    });

    const terminalPanel = document.querySelector(".terminal-panel");
    if (terminalPanel) {
      terminalPanel.addEventListener("mouseup", saveUiPrefs);
      terminalPanel.addEventListener("touchend", saveUiPrefs);
    }

    window.addEventListener("beforeunload", () => {
      if (!isLoggingOut) {
        pushCurrentCodeSnapshot();
        if (!didSendUnloadEvent) {
          didSendUnloadEvent = true;
          reportWindowActivity("unload", "beforeunload");
        }
      }
      saveUiPrefs();
    });

    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        antiCheatStrike(2, "Wyjście z trybu pełnoekranowego");
        applyAntiCheatLock(60000, "Nie opuszczaj trybu pełnoekranowego.");
      }
      enforceExamViewport("fullscreenchange");
    });

    window.addEventListener("resize", () => {
      enforceExamViewport("resize");
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      reportWindowActivity("blur_window", "visibilitychange");
      antiCheatStrike(1, "Przełączenie karty/okna", { source: "visibilitychange" });
    } else {
      reportWindowActivity("focus", "visibilitychange");
    }
  });

  window.addEventListener("blur", function () {
    reportWindowActivity("blur_window", "window_blur");
    antiCheatStrike(1, "Utrata fokusu okna", { source: "window_blur" });
  });

  window.addEventListener("focus", function () {
    reportWindowActivity("focus", "window_focus");
  });

  window.addEventListener("pagehide", function (e) {
    if (didSendUnloadEvent || isLoggingOut) return;
    didSendUnloadEvent = true;
    reportWindowActivity("unload", "pagehide", { persisted: !!e.persisted });
  });
  
  document.addEventListener("copy", function (e) {
    const copied = getCopiedTextFromEvent(e);
    const preview = copied.slice(0, 220);
    const compactPreview = preview.replace(/\s+/g, " ").trim();

    // Force plain-text clipboard payload so pasted content does not carry editor colors/styles.
    if (copied && e?.clipboardData) {
      try {
        e.preventDefault();
        e.clipboardData.setData("text/plain", copied);
      } catch (err) {}
    }

    addActivity("copy", {
      hasSelection: copied.length > 0,
      copiedLength: copied.length,
      copiedPreview: compactPreview,
      reason: compactPreview
        ? ("Skopiowano: \"" + compactPreview + (copied.length > 220 ? "...\"" : "\""))
        : "Skopiowano (nie udało się odczytać treści)"
    });
  });
  
  document.addEventListener("paste", function (e) {
    e.preventDefault();
    if (!e.isTrusted) return;
    addActivity("paste", { clipboardLength: e.clipboardData?.getData('text')?.length || 0 });
    antiCheatStrike(2, "Próba wklejania tekstu");
  });
  
  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    if (!e.isTrusted) return;
    addActivity("right_click", {});
    antiCheatStrike(2, "Kliknięcie prawym przyciskiem");
  });

  document.addEventListener("drop", function (e) {
    e.preventDefault();
    if (!e.isTrusted) return;
    antiCheatStrike(2, "Próba przeciągnięcia pliku/tekstu do IDE");
  });

  setInterval(() => {
    const widthGap = Math.abs(window.outerWidth - window.innerWidth);
    const heightGap = Math.abs(window.outerHeight - window.innerHeight);
    if (widthGap > 170 || heightGap > 170) {
      const now = Date.now();
      if (now - antiCheatDevtoolsWarnAt > 8000) {
        antiCheatDevtoolsWarnAt = now;
        antiCheatStrike(3, "Wykryto prawdopodobnie otwarte DevTools", { widthGap, heightGap });
      }
    }
  }, 1500);

  setInterval(() => {
    enforceExamViewport("viewport_guard");
  }, 3000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
