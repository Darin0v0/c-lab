const STORAGE_KEY = "teacherSettings";
const ACTIVITY_KEY = "studentActivity";
const TEACHER_TOKEN_KEY = "teacher_dashboard_token_v1";
const TEACHER_TOKEN_FALLBACK_KEY = "teacher_token";
let teacherToken = "";

function normalizeTeacherToken(value) {
  return String(value || "").trim().slice(0, 128);
}

function ensureTeacherToken(forcePrompt = false) {
  if (!forcePrompt) {
    try {
      if (!teacherToken) {
        const stored =
          localStorage.getItem(TEACHER_TOKEN_KEY) ||
          localStorage.getItem(TEACHER_TOKEN_FALLBACK_KEY) ||
          "";
        teacherToken = normalizeTeacherToken(stored);
      }
    } catch (e) {}
  }

  if (!teacherToken || forcePrompt) {
    const provided = prompt("Podaj PIN nauczyciela:");
    const normalized = normalizeTeacherToken(provided);
    if (!normalized) return false;
    teacherToken = normalized;
    try {
      localStorage.setItem(TEACHER_TOKEN_KEY, teacherToken);
    } catch (e) {}
  }

  return true;
}

async function teacherFetch(url, options = {}) {
  if (!ensureTeacherToken()) {
    throw new Error("missing_teacher_token");
  }

  const merged = { ...options };
  const headers = { ...(options.headers || {}), "x-teacher-token": teacherToken };
  merged.headers = headers;

  const response = await fetch(url, merged);
  if (response.status === 403) {
    teacherToken = "";
    try {
      localStorage.removeItem(TEACHER_TOKEN_KEY);
      localStorage.removeItem(TEACHER_TOKEN_FALLBACK_KEY);
    } catch (e) {}
  }
  return response;
}

const studentForm = document.getElementById("studentForm");
const studentFirstNameInput = document.getElementById("studentFirstName");
const studentLastNameInput = document.getElementById("studentLastName");
const studentSearchInput = document.getElementById("studentSearch");
const generateButton = document.getElementById("generateButton");
const exportButton = document.getElementById("exportButton");
const importButton = document.getElementById("importButton");
const importFileInput = document.getElementById("importFile");
const studentsTableBody = document.querySelector("#studentsTable tbody");
const activityLog = document.getElementById("activityLog");
const lastSavedLabel = document.getElementById("lastSaved");
const backupButton = document.getElementById("backupButton");
const clearButton = document.getElementById("clearButton");
const refreshDataButton = document.getElementById("refreshDataButton");
const refreshLogButton = document.getElementById("refreshLogButton");
const clearLogButton = document.getElementById("clearLogButton");
const logContainer = document.getElementById("logContainer");

if (location.protocol === "file:") {
  alert("UWAGA: Strona musi działać przez serwer! Uruchom 'node server.js' i otwórz http://localhost:3000/teacher.html");
}

function formatTime(ts) {
  return new Date(ts).toLocaleString("pl-PL");
}

async function loadStudentsFromServer() {
  console.log('[Teacher] Fetching students from /api/students...');
  try {
    const response = await teacherFetch('/api/students');
    console.log('[Teacher] Response status:', response.status);
    if (!response.ok) throw new Error('Failed to fetch students');
    const data = await response.json();
    console.log('[Teacher] Got students:', data.length, data);
    return data;
  } catch (err) {
    console.error('[Teacher] Error loading students:', err);
    return [];
  }
}

async function loadActivitiesFromServer(studentId) {
  console.log('[Teacher] Fetching activities for:', studentId);
  try {
    const response = await teacherFetch(`/api/activities/${studentId}`);
    if (!response.ok) throw new Error('Failed to fetch activities');
    const data = await response.json();
    console.log('[Teacher] Got activities:', data.length);
    return data;
  } catch (err) {
    console.error('[Teacher] Error loading activities:', err);
    return [];
  }
}

async function loadAllActivities() {
  const activities = {};
  try {
    const students = await loadStudentsFromServer();
    console.log('[Teacher] Loading activities for', students.length, 'students');
    for (const student of students) {
      const acts = await loadActivitiesFromServer(student.id);
      console.log('[Teacher] Student', student.id, 'has', acts.length, 'activities');
      if (acts.length > 0) {
        activities[student.id] = acts;
      }
    }
  } catch (err) {
    console.error('Error loading all activities:', err);
  }
  return activities;
}

let serverStudents = [];
let serverActivities = {};

async function syncFromServer() {
  console.log('[Teacher] Syncing from server...');
  serverStudents = await loadStudentsFromServer();
  serverActivities = await loadAllActivities();
  console.log('[Teacher] Sync complete. Students:', serverStudents.length, 'Activities keys:', Object.keys(serverActivities).length);
}

async function refreshAllData() {
  await syncFromServer();
  renderStudents(studentSearchInput?.value || "");
}

function loadStudents() {
  return serverStudents;
}

function saveStudents(list) {
  serverStudents = list;
}

function getActivityLog() {
  return serverActivities;
}

function setLastSaved(ts) {
  lastSavedLabel.textContent = formatTime(ts);
}

function loadLastSaved() {
  lastSavedLabel.textContent = "dane z serwera";
}

function getAwayStatus(events = []) {
  const relevant = events.filter(
    (e) =>
      e && (e.type === "focus" || e.type === "blur" || e.type === "unload"),
  );
  if (relevant.length === 0) return { away: false, label: "" };
  const last = relevant.reduce(
    (a, b) => ((a?.ts || 0) > (b?.ts || 0) ? a : b),
    null,
  );
  if (!last) return { away: false, label: "" };
  if (last.type === "unload")
    return { away: true, label: "Wyszedł / odświeżył" };
  if (last.type === "blur") return { away: true, label: "Poza oknem" };
  return { away: false, label: "" };
}

function downloadJSON(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function generateTestData(count = 200) {
  const firstNames = [
    "Jan", "Anna", "Marek", "Kasia", "Piotr", "Barbara", "Tomasz", "Agnieszka", "Paweł", "Justyna",
  ];
  const classNames = ["3a", "2b", "3c", "1a", "2a"];
  const journalNums = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

  const students = loadStudents();
  for (let i = 0; i < count; i++) {
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const className = classNames[Math.floor(Math.random() * classNames.length)];
    const journalNum = journalNums[Math.floor(Math.random() * journalNums.length)];
    const id = Storage.nextId();
    students.push({
      id,
      firstName,
      className,
      journalNum,
      lastSeen: Date.now() - Math.floor(Math.random() * 1000 * 60 * 60),
    });

    const activity = getActivityLog();
    const events = [];
    const now = Date.now();
    for (let j = 0; j < 3; j++) {
      events.push({
        ts: now - j * 1000 * 60 * Math.random(),
        type: "compile",
        details: { success: Math.random() > 0.4 },
      });
    }
    activity[id] = events;
    Storage.save(ACTIVITY_KEY, activity);
  }

  saveStudents(students);
  renderStudents(studentSearchInput.value);
}

function isOnline(lastSeen) {
  if (!lastSeen) return false;
  const delta = Date.now() - lastSeen;
  return delta < 1000 * 60 * 2;
}

function isLoggedOut(student) {
  return student && student.loggedOut === true;
}

function renderStudents(filter = "") {
  const students = loadStudents();
  studentsTableBody.innerHTML = "";

  const activity = getActivityLog();

  const normalizedFilter = filter.trim().toLowerCase();
  const visibleStudents = students
    .filter((student) => {
      if (!normalizedFilter) return true;
      const fullName = `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim().toLowerCase();
      const id = (student.id ?? "").toLowerCase();
      return fullName.includes(normalizedFilter) || id.includes(normalizedFilter);
    })
    .sort((a, b) => {
      const aSeen = a.lastSeen || 0;
      const bSeen = b.lastSeen || 0;
      return bSeen - aSeen;
    });

  visibleStudents.forEach((student) => {
    const tr = document.createElement("tr");
    tr.dataset.studentId = student.id;
    if (activityLog.dataset.selected === student.id) {
      tr.style.background = "rgba(59, 130, 246, 0.15)";
    }
    
    const isLogged = isLoggedOut(student);
    if (isLogged) {
      tr.style.opacity = "0.5";
    }

    const events = activity[student.id] || [];
    const lastEvents = events.slice(-3).reverse();
    const last = lastEvents.length ? formatTime(lastEvents[0].ts) : "brak";
    const hasSuspicious = events.some((e) => e.type === "suspicious");
    const fullName =
      `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim() || student.name || "";
    const online = isOnline(student.lastSeen);
    const awayStatus = getAwayStatus(events);

    const compiles = events.filter(e => e.type === "compile").length;
    const compileErrors = events.filter(e => e.type === "compile" && e.details?.success === false).length;
    const blurs = events.filter(e => e.type === "blur" || e.type === "unload").length;
    const copies = events.filter(e => e.type === "copy").length;
    const pastes = events.filter(e => e.type === "paste").length;
    const saves = events.filter(e => e.type === "save").length;

    const riskLevel = (hasSuspicious ? 3 : 0) + (blurs > 5 ? 2 : blurs > 2 ? 1 : 0) + (copies > 10 ? 1 : 0) + (pastes > 10 ? 1 : 0);
    const riskColor = riskLevel === 0 ? "#10b981" : riskLevel <= 2 ? "#f59e0b" : "#ef4444";
    const riskLabel = riskLevel === 0 ? "OK" : riskLevel <= 2 ? "Uwaga" : "⚠️";
    const fullNameSafe = escapeHtml(fullName);
    const awayLabelSafe = escapeHtml(awayStatus.label || "");
    const riskLabelSafe = escapeHtml(riskLabel);
    const studentIdShortSafe = escapeHtml(String(student.id || "").slice(-8));

    tr.innerHTML = `
      <td>
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <span>${fullNameSafe}</span>
          ${online ? `<span class="badge" style="background: rgba(52, 211, 153, 0.18); color: #10b981;">Online</span>` : ""}
          ${isLogged ? `<span class="badge" style="background: rgba(107, 114, 128, 0.18); color: #6b7280;">Wylogowany</span>` : ""}
          ${awayStatus.away ? `<span class="badge" style="background: rgba(248,113,113,0.18); color: #dc2626;">${awayLabelSafe}</span>` : ""}
          ${hasSuspicious ? `<span class="badge" style="background: rgba(248,113,113,0.18); color: #dc2626;">Podejrzane</span>` : ""}
          <span class="badge" style="background: ${riskColor}22; color: ${riskColor}; border: 1px solid ${riskColor}44;">${riskLabelSafe}</span>
        </div>
        <div class="small" style="color: #6b7280; margin-top: 0.25rem;">
          🔨 ${compiles} ${compileErrors > 0 ? `(${compileErrors} bł.)` : ""} · 🚪 ${blurs} · 📋 ${copies} · 📝 ${pastes}
          ${saves > 0 ? `· 💾 ${saves}` : ""}
        </div>
      </td>
      <td><code>${studentIdShortSafe}</code></td>
      <td>${last}</td>
      <td style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button class="button" data-action="view" data-id="${student.id}">Pokaż log</button>
        ${isLogged ? `<button class="button" data-action="view_code" data-id="${student.id}" style="background:#6366f1;">Kod</button>` : ""}
        <button class="button" data-action="delete" data-id="${student.id}" style="background:#f43f5e; color:#111827;">Usuń</button>
      </td>
    `;

    studentsTableBody.appendChild(tr);
  });
}

function renderActivity(studentId) {
  const activity = getActivityLog();
  const events = (activity[studentId] || []).slice().reverse();
  renderActivityFromServer(events);
}

function getActivityIcon(type) {
  const icons = {
    compile: "🔨", compileError: "❌", windowBlur: "🚪", windowFocus: "📍",
    copy: "📋", paste: "📝", save: "💾", loadExample: "📄", reset: "🔄",
    logout: "👋", suspicious: "⚠️", view: "👁️", focus: "🖥️", blur: "💨", unload: "🚪",
    online: "🟢", offline: "🔴",
  };
  return icons[type] || "•";
}

function getActivityColor(type) {
  const colors = {
    compile: "#22c55e", loadExample: "#3b82f6", reset: "#8b5cf6", view: "#6b7280",
    focus: "#10b981", blur: "#f59e0b", unload: "#dc2626", copy: "#6366f1",
    paste: "#8b5cf6", suspicious: "#dc2626", logout: "#6b7280",
  };
  return colors[type] || "#d4d4d4";
}

function getActivityLabel(type) {
  const labels = {
    compile: "Kompilacja", loadExample: "Wczytanie przykładu", reset: "Reset kodu",
    view: "Wejście", focus: "Focus okna", blur: "Wyjście z okna", unload: "Zamknięcie strony",
    copy: "Kopiowanie", paste: "Wklejanie", save: "Zapis pliku", suspicious: "⚠️ Podejrzane",
    logout: "Wylogowanie", online: "Online", offline: "Offline",
  };
  return labels[type] || type;
}

function renderActivityFromServer(events) {
  if (!activityLog) return;
  
  if (!events || events.length === 0) {
    activityLog.innerHTML = "<p class='small'>Brak zarejestrowanych zdarzeń dla wybranego ucznia.</p>";
    return;
  }

  const stats = { compiles: 0, compileErrors: 0, copies: 0, pastes: 0, blurs: 0, unloads: 0, saves: 0, suspicious: 0 };

  events.forEach(e => {
    if (e.type === "compile") { stats.compiles++; if (e.details && e.details.success === false) stats.compileErrors++; }
    if (e.type === "copy") stats.copies++;
    if (e.type === "paste") stats.pastes++;
    if (e.type === "blur") stats.blurs++;
    if (e.type === "unload") stats.unloads++;
    if (e.type === "save") stats.saves++;
    if (e.type === "suspicious") stats.suspicious++;
  });

  const statsHtml = `
    <div style="display: flex; flex-wrap: wrap; gap: 1rem; padding: 0.75rem; background: rgba(30,41,59,0.5); border-radius: 6px; margin-bottom: 1rem;">
      <div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #3b82f6;">${stats.compiles}</div><div style="font-size: 0.7rem; color: #9ca3af;">Kompilacji</div></div>
      <div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #ef4444;">${stats.compileErrors}</div><div style="font-size: 0.7rem; color: #9ca3af;">Błędów</div></div>
      <div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #f59e0b;">${stats.blurs + stats.unloads}</div><div style="font-size: 0.7rem; color: #9ca3af;">Wyjścia</div></div>
      <div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #6366f1;">${stats.copies}</div><div style="font-size: 0.7rem; color: #9ca3af;">Kopii</div></div>
      <div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #8b5cf6;">${stats.pastes}</div><div style="font-size: 0.7rem; color: #9ca3af;">Wklejeń</div></div>
      ${stats.saves > 0 ? `<div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #10b981;">${stats.saves}</div><div style="font-size: 0.7rem; color: #9ca3af;">💾 Zapisów</div></div>` : ""}
      ${stats.suspicious > 0 ? `<div style="text-align: center;"><div style="font-size: 1.5rem; font-weight: bold; color: #dc2626;">${stats.suspicious}</div><div style="font-size: 0.7rem; color: #9ca3af;">⚠️ Podejrzane</div></div>` : ""}
    </div>
  `;

  const rows = events.map((event) => {
    const at = new Date(event.ts).toLocaleString("pl-PL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const icon = getActivityIcon(event.type);
    const color = getActivityColor(event.type);
    const label = escapeHtml(getActivityLabel(event.type));
    const isSuspicious = event.type === "suspicious";
    const isAway = event.type === "blur" || event.type === "unload";
    
    let detailsHtml = "";
    if (event.details) {
      const d = event.details;
      if (d.success !== undefined) detailsHtml = d.success ? `<span style="color: #22c55e;"> ✓ OK</span>` : `<span style="color: #ef4444;"> ✗ Błąd</span>`;
      if (d.example) detailsHtml = `<span style="color: #60a5fa;"> ${escapeHtml(d.example)}</span>`;
      if (d.reason) detailsHtml = `<span style="color: #fbbf24;"> ${escapeHtml(d.reason)}</span>`;
      if (d.errors && d.errors.length > 0) detailsHtml = `<span style="color: #ef4444;"> ${d.errors.length} błędów</span>`;
      if (d.note) detailsHtml = `<span style="color: #9ca3af;"> ${escapeHtml(d.note)}</span>`;
      if (d.filename) detailsHtml = `<span style="color: #10b981;"> ${escapeHtml(d.filename)}</span>`;
    }

    return `<div style='padding:0.5rem 0.75rem; border-bottom: 1px solid rgba(226,232,240,0.1); background: ${isAway ? "rgba(248,113,113,0.12)" : isSuspicious ? "rgba(248,113,113,0.08)" : "transparent"}; border-left: 3px solid ${color};'>
      <div style="display: flex; align-items: center; gap: 0.5rem;"><span>${icon}</span><span style="color: ${color}; font-weight: 600;">${label}</span>${detailsHtml}</div>
      <div style="color: #6b7280; font-size: 0.75rem; margin-top: 0.25rem;">${at}</div>
    </div>`;
  }).join("");

  activityLog.innerHTML = statsHtml + rows;
}

function backupDatabase() {
  setLastSaved(Date.now());
  renderStudents();
}

function clearDatabase() {
  if (!confirm("Na pewno chcesz wyczyścić dane lokalne?")) return;
  renderStudents();
  activityLog.innerHTML = "";
  setLastSaved(Date.now());
}

studentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const firstName = studentFirstNameInput.value.trim();
  const lastName = studentLastNameInput.value.trim();
  if (!firstName || !lastName) return;

  const id = Storage.nextId();
  
  try {
    await teacherFetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, firstName, lastName }),
    });
  } catch (err) {
    console.error('Error adding student:', err);
  }
  
  studentFirstNameInput.value = "";
  studentLastNameInput.value = "";
  await syncFromServer();
  renderStudents(studentSearchInput.value);
});

studentsTableBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  
  if (!button) {
    const row = event.target.closest("tr");
    if (row) {
      const id = row.dataset.studentId;
      if (id) {
        activityLog.dataset.selected = id;
        await syncFromServer();
        const activities = serverActivities[id] || [];
        renderActivityFromServer(activities);
      }
      return;
    }
    return;
  }

  const action = button.dataset.action;
  const id = button.dataset.id;
  if (!action || !id) return;

  if (action === "delete") {
    try {
      await teacherFetch(`/api/students/${id}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Error deleting student:', err);
    }
    await syncFromServer();
    renderStudents(studentSearchInput.value);
    if (activityLog.dataset.selected === id) {
      activityLog.innerHTML = "";
    }
    return;
  }

  if (action === "view") {
    activityLog.dataset.selected = id;
    await syncFromServer();
    const activities = serverActivities[id] || [];
    renderActivityFromServer(activities);
  }
  
  if (action === "view_code") {
    activityLog.dataset.selected = id;
    await syncFromServer();
    const activities = serverActivities[id] || [];
    renderActivityFromServer(activities);
    
    try {
      const response = await teacherFetch(`/api/student/${id}/code`);
      const data = await response.json();
      if (data.code) {
        let codeHtml = activityLog.innerHTML;
        codeHtml += `<div style="margin-top: 1rem; padding: 1rem; background: #1e293b; border-radius: 6px;">
          <div style="font-weight: 600; margin-bottom: 0.5rem; color: #6366f1;">📄 Ostatni zapisany kod ucznia:</div>
          <pre style="background: #0f172a; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; max-height: 400px;">${data.code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
        </div>`;
        activityLog.innerHTML = codeHtml;
      }
    } catch (err) {
      console.error('Error loading student code:', err);
    }
  }
});

window.addEventListener("network-update", (event) => {
  refreshAllData();
});

if (studentSearchInput) {
  studentSearchInput.addEventListener("input", () => {
    renderStudents(studentSearchInput.value);
  });
}

if (generateButton) {
  generateButton.addEventListener("click", () => {
    const count = parseInt(prompt("Ile uczniów wygenerować? (max 2000)", "200"), 10);
    if (Number.isFinite(count) && count > 0) {
      generateTestData(Math.min(count, 2000));
    }
  });
}

if (exportButton) {
  exportButton.addEventListener("click", () => {
    const db = loadStudents();
    const activity = getActivityLog();
    downloadJSON(`students-${Date.now()}.json`, { students: db, activity });
  });
}

if (importButton && importFileInput) {
  importButton.addEventListener("click", () => {
    importFileInput.click();
  });

  importFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = await importJSON(file);
      if (data?.students) saveStudents(data.students);
      if (data?.activity) Storage.save(ACTIVITY_KEY, data.activity);
      renderStudents(studentSearchInput.value);
      alert("Import zakończony.");
    } catch (err) {
      alert("Nie udało się zaimportować pliku JSON: " + err);
    }
    event.target.value = "";
  });
}

backupButton.addEventListener("click", () => {
  backupDatabase();
});

clearButton.addEventListener("click", () => {
  clearDatabase();
});

refreshDataButton?.addEventListener("click", async () => {
  console.log('[Teacher] Manual refresh clicked');
  await refreshAllData();
  alert('Dane odświeżone!');
});

// ====== Log serwera ======

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadLogFromServer() {
  try {
    const response = await teacherFetch('/api/log');
    if (!response.ok) throw new Error('Failed to fetch log');
    return await response.json();
  } catch (err) {
    console.error('Error loading log:', err);
    return [];
  }
}

async function refreshLog() {
  if (!logContainer) return;
  const logs = await loadLogFromServer();
  if (logs.length === 0) {
    logContainer.innerHTML = '<span style="color: #888;">Brak logów</span>';
    return;
  }
  logContainer.innerHTML = logs.map(line => escapeHtml(line)).join('\n');
  logContainer.scrollTop = logContainer.scrollHeight;
}

refreshLogButton?.addEventListener('click', refreshLog);

clearLogButton?.addEventListener('click', async () => {
  if (!confirm('Na pewno chcesz wyczyścić plik loga serwera?')) return;
  try {
    const response = await teacherFetch('/api/log/clear', { method: 'POST' });
    if (response.ok) refreshLog();
  } catch (err) {
    console.error('Error clearing log:', err);
  }
});

// ====== Inicjalizacja ======

async function refreshActivity() {
  if (activityLog.dataset.selected) {
    await syncFromServer();
    const activities = serverActivities[activityLog.dataset.selected] || [];
    console.log('[Teacher] Activities for', activityLog.dataset.selected, ':', activities.length, activities);
    renderActivityFromServer([...activities].reverse());
  }
}

setInterval(() => {
  refreshAllData();
  refreshActivity();
  refreshLog();
}, 5000);

refreshAllData();
refreshLog();

setTimeout(() => {
  const firstRow = studentsTableBody?.querySelector("tr");
  if (firstRow && firstRow.dataset.studentId) {
    const firstId = firstRow.dataset.studentId;
    activityLog.dataset.selected = firstId;
    firstRow.style.background = "rgba(59, 130, 246, 0.15)";
    const activities = serverActivities[firstId] || [];
    renderActivityFromServer(activities);
  }
}, 500);
