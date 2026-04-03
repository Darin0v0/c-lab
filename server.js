const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");
const https = require("https");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = 3000;
const DB_FILE = path.join(__dirname, "database.json");
const SESSIONS_DIR = path.join(__dirname, "sessions");
const LOG_FILE = path.join(__dirname, "server.log");
const STUDENTS_DATA_DIR = path.join(__dirname, "students_data");

// Create students data directory if not exists
if (!fs.existsSync(STUDENTS_DATA_DIR)) {
  fs.mkdirSync(STUDENTS_DATA_DIR, { recursive: true });
}

// Helper function to create safe folder name from student data
function getStudentFolderName(firstName, journalNum, className) {
  const safeFirstName = (firstName && firstName !== 'undefined') ? String(firstName).replace(/[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, '_') : '';
  const safeJournalNum = (journalNum && journalNum !== 'undefined') ? String(journalNum).replace(/[^a-zA-Z0-9]/g, '') : '';
  const safeClassName = (className && className !== 'undefined') ? String(className).replace(/[^a-zA-Z0-9]/g, '') : '';
  
  if (safeFirstName) {
    if (safeJournalNum && safeClassName) {
      return `${safeFirstName}_${safeClassName}_${safeJournalNum}`.toLowerCase();
    }
    return `${safeFirstName}`.toLowerCase();
  }
  return 'unknown';
}

function getStudentDir(studentId, firstName, journalNum, className) {
  let folderName;
  
  if (firstName) {
    folderName = getStudentFolderName(firstName, journalNum, className);
  } else {
    folderName = studentId;
  }
  
  const studentDir = path.join(STUDENTS_DATA_DIR, folderName);
  if (!fs.existsSync(studentDir)) {
    fs.mkdirSync(studentDir, { recursive: true });
  }
  return studentDir;
}

function saveStudentCode(studentId, code, firstName, journalNum, className) {
  const studentDir = getStudentDir(studentId, firstName, journalNum, className);
  const codeFile = path.join(studentDir, "code.cpp");
  fs.writeFileSync(codeFile, code || "");
  log(`Saved code for student ${firstName}`);
}

function resetStudentCode(studentId, firstName, journalNum, className) {
  // Primary path based on current student metadata.
  if (studentId && firstName) {
    try {
      saveStudentCode(studentId, "", firstName, journalNum || "", className || "");
    } catch (e) {}
  }

  // Fallback: locate folders by info.json with matching student id.
  try {
    const dirs = fs.readdirSync(STUDENTS_DATA_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    dirs.forEach((dirName) => {
      try {
        const dirPath = path.join(STUDENTS_DATA_DIR, dirName);
        const infoFile = path.join(dirPath, "info.json");
        if (!fs.existsSync(infoFile)) return;
        const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
        if (!info || info.id !== studentId) return;
        fs.writeFileSync(path.join(dirPath, "code.cpp"), "");
      } catch (e) {}
    });
  } catch (e) {}
}

function getStudentCode(studentId, firstName, journalNum, className) {
  const studentDir = getStudentDir(studentId, firstName, journalNum, className);
  const codeFile = path.join(studentDir, "code.cpp");
  if (fs.existsSync(codeFile)) {
    return fs.readFileSync(codeFile, "utf8");
  }
  return "";
}

function saveStudentActivities(studentId, activities, firstName, journalNum, className) {
  const studentDir = getStudentDir(studentId, firstName, journalNum, className);
  const activitiesFile = path.join(studentDir, "activities.json");
  fs.writeFileSync(activitiesFile, JSON.stringify(activities, null, 2));
  log(`Saved activities for student ${firstName}`);
}

function getStudentActivities(studentId, firstName, journalNum, className) {
  const studentDir = getStudentDir(studentId, firstName, journalNum, className);
  const activitiesFile = path.join(studentDir, "activities.json");
  if (fs.existsSync(activitiesFile)) {
    try {
      return JSON.parse(fs.readFileSync(activitiesFile, "utf8"));
    } catch (e) {
      return [];
    }
  }
  return [];
}

function saveStudentInfo(studentId, info, firstName, journalNum, className) {
  const studentDir = getStudentDir(studentId, firstName, journalNum, className);
  const infoFile = path.join(studentDir, "info.json");
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
  log(`Saved info for student ${firstName}`);
}

function getStudentInfo(studentId, firstName, journalNum, className) {
  const studentDir = getStudentDir(studentId, firstName, journalNum, className);
  const infoFile = path.join(studentDir, "info.json");
  if (fs.existsSync(infoFile)) {
    try {
      return JSON.parse(fs.readFileSync(infoFile, "utf8"));
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Online Compiler API
const API_KEY = String(process.env.ONLINE_COMPILER_API_KEY || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 128);
const COMPILER_CPP = "g++-15";

const MAX_PROGRAM_RUNTIME = 60000;
const MAX_COMPILE_TIME = 10000;
const MAX_OUTPUT_SIZE = 100000;
const MAX_CODE_LENGTH = 100000;
const MAX_STDIN_LENGTH = 8000;
const MAX_INPUT_LENGTH = 2000;
const MAX_ACTIVITY_LOG_ITEMS = 1000;
const MAX_ACTIVITY_KEEP_ITEMS = 500;
const RAW_TEACHER_TOKEN = String(process.env.TEACHER_TOKEN || process.env.TEACHER_PIN || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 128);
const TEACHER_TOKEN = RAW_TEACHER_TOKEN || crypto.randomBytes(24).toString("hex");
const ANTI_CHEAT_WINDOW_MS = 120000;
const ANTI_CHEAT_WARN_SCORE = 5;
const ANTI_CHEAT_LOCK_SCORE = 9;
const ANTI_CHEAT_LOGOUT_SCORE = 14;
const ALLOWED_ACTIVITY_TYPES = new Set([
  "view", "run", "compile", "blur_window", "focus", "logout",
  "copy", "paste", "right_click", "suspicious", "unload", "task_received", "message_received"
]);

function trimText(value, max = 120) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function sanitizeStudentId(value, fallback = "") {
  const raw = trimText(String(value || ""), 128);
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return safe || fallback;
}

function sanitizeDisplayText(value, fallback = "", max = 80) {
  const safe = trimText(value, max);
  return safe || fallback;
}

function sanitizeActivity(activity) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return null;

  const rawType = trimText(String(activity.type || ""), 40);
  const type = ALLOWED_ACTIVITY_TYPES.has(rawType) ? rawType : "suspicious";
  const tsRaw = Number(activity.ts);
  const ts = Number.isFinite(tsRaw) ? tsRaw : Date.now();

  const details = {};
  if (activity.details && typeof activity.details === "object" && !Array.isArray(activity.details)) {
    const entries = Object.entries(activity.details).slice(0, 12);
    for (const [keyRaw, value] of entries) {
      const key = trimText(String(keyRaw || ""), 40);
      if (!key) continue;
      if (typeof value === "number" && Number.isFinite(value)) {
        details[key] = value;
        continue;
      }
      if (typeof value === "boolean") {
        details[key] = value;
        continue;
      }
      details[key] = trimText(String(value ?? ""), 300);
    }
  }

  return { ts, type, details };
}

function sanitizeStudentPayload(student, fallbackId) {
  const id = sanitizeStudentId(student?.id, fallbackId || `unknown_${Date.now()}`);
  const firstName = sanitizeDisplayText(student?.firstName, "Uczen", 80);
  const journalNum = sanitizeDisplayText(student?.journalNum, "", 24);
  const className = sanitizeDisplayText(student?.className, "", 24);
  return { id, firstName, journalNum, className };
}

function rateLimitBucket(bucket, limit, windowMs) {
  const now = Date.now();
  if (!bucket.windowStart || now - bucket.windowStart > windowMs) {
    bucket.windowStart = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

function getAntiCheatWeight(activity) {
  if (!activity || typeof activity !== "object") return 0;
  const type = String(activity.type || "").toLowerCase();
  const reason = String(activity?.details?.reason || "").toLowerCase();
  if (type === "paste") return 2;
  if (type === "right_click") return 2;
  if (type === "blur_window" || type === "unload") return 0;
  if (type === "suspicious") {
    if (reason.includes("devtools")) return 4;
    if (reason.includes("wklej")) return 3;
    return 3;
  }
  return 0;
}

function extractTeacherTokenFromReq(req) {
  const direct = trimText(req.headers["x-teacher-token"] || "", 128);
  if (direct) return direct;

  const auth = trimText(req.headers.authorization || "", 256);
  if (auth.toLowerCase().startsWith("bearer ")) {
    return trimText(auth.slice(7), 128);
  }

  const queryToken = trimText(req.query?.teacherToken || "", 128);
  if (queryToken) return queryToken;

  const bodyToken = trimText(req.body?.teacherToken || "", 128);
  if (bodyToken) return bodyToken;

  return "";
}

function isTeacherTokenValid(token) {
  return !!TEACHER_TOKEN && token === TEACHER_TOKEN;
}

function requireTeacherAuth(req, res, next) {
  const token = extractTeacherTokenFromReq(req);
  if (!isTeacherTokenValid(token)) {
    return res.status(403).json({ error: "Teacher auth required" });
  }
  next();
}

function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(" ")}`;
  console.log(message);
  fs.appendFileSync(LOG_FILE, message + "\n");
}

function compileOnlyLocal(code) {
  return new Promise((resolve) => {
    const jobId = `cpp_${Date.now()}`;
    const srcFile = path.join(TEMP_DIR, `${jobId}.cpp`);
    const exeFile = path.join(TEMP_DIR, jobId);

    fs.writeFileSync(srcFile, code);

    const proc = spawn("g++", ["-o", exeFile, srcFile, "-std=c++17", "-O2"]);
    let killed = false;
    let stderr = "";

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill();
      resolve({ error: "Kompilacja przekroczyła limit czasu (10s)", status: "error" });
    }, MAX_COMPILE_TIME);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (killed) return;
      if (code === 0) {
        fs.unlink(srcFile, () => {});
        fs.unlink(exeFile, () => {});
        resolve({ status: "success" });
      } else {
        resolve({ error: stderr, status: "error" });
      }
    });

    proc.stderr.on("data", (data) => { stderr += data.toString(); });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ error: err.message, status: "error" });
    });
  });
}

function runOnlineCompiler(code, stdin = "") {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      compileOnlyLocal(code).then(resolve).catch(reject);
      return;
    }

    const postData = JSON.stringify({
      compiler: COMPILER_CPP,
      code: code,
      input: stdin
    });

    const options = {
      hostname: "api.onlinecompiler.io",
      port: 443,
      path: "/api/run-code-sync/",
      method: "POST",
      headers: {
        "Authorization": API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => {
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

const STATIC_ROOT_FILES = new Set([
  "/", "/index.html", "/student.html", "/teacher.html", "/debug.html",
  "/przyklad1.txt", "/przyklad2.txt", "/examples.txt", "/liczby.txt"
]);

app.get("*splat", (req, res, next) => {
  if (!STATIC_ROOT_FILES.has(req.path)) return next();
  const file = req.path === "/" ? "index.html" : req.path.slice(1);
  res.sendFile(path.join(__dirname, file));
});

app.use("/js", express.static(path.join(__dirname, "js"), { index: false, fallthrough: true }));
app.use("/css", express.static(path.join(__dirname, "css"), { index: false, fallthrough: true }));
app.use("/public", express.static(path.join(__dirname, "public"), { index: false, fallthrough: true }));
app.use(express.json({ limit: "256kb" }));

const httpRate = new Map();
function rateLimitHttp(limit, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    const bucket = httpRate.get(key) || { start: now, count: 0 };
    if (now - bucket.start > windowMs) {
      bucket.start = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    httpRate.set(key, bucket);
    if (bucket.count > limit) {
      return res.status(429).json({ error: "Too many requests" });
    }
    next();
  };
}

// ============================================
// BAZA DANYCH
// ============================================

let db = { students: [], activities: {}, submissions: [] };

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
} else {
  try {
    const data = fs.readFileSync(DB_FILE, "utf8");
    db = JSON.parse(data);
  } catch (err) {
    log("DB error:", err.message);
  }
}

function saveDatabase() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function safeRemoveDirRecursive(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return;
    if (typeof fs.rmSync === "function") {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    }
    // Fallback for older Node versions
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        safeRemoveDirRecursive(fullPath);
      } else {
        try { fs.unlinkSync(fullPath); } catch (e) {}
      }
    });
    try { fs.rmdirSync(dirPath); } catch (e) {}
  } catch (e) {}
}

function resetAllStudentsData() {
  // Remove all student-related records from DB.
  db.students = [];
  db.activities = {};
  db.submissions = [];
  saveDatabase();

  // Remove persisted student files and sessions.
  safeRemoveDirRecursive(STUDENTS_DATA_DIR);
  safeRemoveDirRecursive(SESSIONS_DIR);
  fs.mkdirSync(STUDENTS_DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  // Disconnect all currently connected student sockets.
  Object.keys(connectedStudents).forEach((socketId) => {
    try {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    } catch (e) {}
  });
  connectedStudents = {};

  // Stop running student processes.
  Object.keys(runningProcesses).forEach((socketId) => {
    try {
      const running = runningProcesses[socketId];
      if (running?.proc?.stdin && running.proc.stdin.writable) {
        running.proc.stdin.end();
      }
      if (running?.proc) running.proc.kill();
    } catch (e) {}
    delete runningProcesses[socketId];
  });
}

function saveStudentSession(studentId, data) {
  const filepath = path.join(SESSIONS_DIR, `${studentId}.json`);
  fs.writeFileSync(filepath, JSON.stringify({
    ...data,
    savedAt: Date.now(),
    savedAtReadable: new Date().toLocaleString("pl-PL")
  }, null, 2));
}

// ============================================
// KOMPILATOR C++
// ============================================

const TEMP_DIR = path.join(os.tmpdir(), "cpp_runner");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function cleanupFiles(srcFile, exeFile) {
  try { if (fs.existsSync(srcFile)) fs.unlinkSync(srcFile); } catch(e) {}
  try { if (fs.existsSync(exeFile)) fs.unlinkSync(exeFile); } catch(e) {}
}

async function compileAndRun(code, stdin) {
  const startTime = Date.now();
  const jobId = `cpp_${Date.now()}`;
  const srcFile = path.join(TEMP_DIR, `${jobId}.cpp`);
  const exeFile = path.join(TEMP_DIR, jobId);

  try {
    fs.writeFileSync(srcFile, code);

    const compileResult = await new Promise((resolve) => {
      const proc = spawn("g++", ["-o", exeFile, srcFile, "-std=c++17", "-O2"]);
      let killed = false;
      
      const timeout = setTimeout(() => {
        killed = true;
        proc.kill();
        resolve({ code: -1, stderr: "Kompilacja przekroczyła limit czasu (10s)" });
      }, MAX_COMPILE_TIME);
      
      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (!killed) resolve({ code, stderr: "" });
      });
      
      let stderr = "";
      proc.stderr.on("data", (data) => { stderr += data.toString(); });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ code: -1, stderr: err.message });
      });
    });

    if (compileResult.code !== 0) {
      cleanupFiles(srcFile, exeFile);
      return { 
        success: false, 
        output: "",
        errors: compileResult.stderr.split("\n").filter(l => l.trim()).slice(0, 10),
        ms: Date.now() - startTime
      };
    }

    const runResult = await new Promise((resolve) => {
      const proc = spawn(exeFile, [], { timeout: MAX_PROGRAM_RUNTIME });
      let stdout = "", stderr = "";
      let outputSize = 0;
      
      const timeout = setTimeout(() => {
        proc.kill();
        resolve({ code: -2, stdout, stderr, error: "Program przekroczył limit czasu (60s)" });
      }, MAX_PROGRAM_RUNTIME);
      
      proc.stdout.on("data", (data) => {
        if (outputSize < MAX_OUTPUT_SIZE) {
          stdout += data.toString();
          outputSize += data.length;
        }
      });
      proc.stderr.on("data", (data) => {
        if (outputSize < MAX_OUTPUT_SIZE) {
          stderr += data.toString();
          outputSize += data.length;
        }
      });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr });
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ code: -1, stdout: "", stderr: err.message });
      });
      
      if (stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      } else {
        proc.stdin.end();
      }
    });

    cleanupFiles(srcFile, exeFile);

    if (runResult.code !== 0 && runResult.code !== -2) {
      return { 
        success: false, 
        output: runResult.stdout,
        errors: [`Exit code: ${runResult.code}`, runResult.stderr].filter(Boolean),
        ms: Date.now() - startTime
      };
    }

    if (runResult.code === -2) {
      return {
        success: false,
        output: runResult.stdout,
        errors: [runResult.error || "Program przekroczył limit czasu"],
        ms: Date.now() - startTime
      };
    }

    return { 
      success: true, 
      output: runResult.stdout.trim(), 
      errors: [],
      ms: Date.now() - startTime
    };

  } catch (err) {
    cleanupFiles(srcFile, exeFile);
    return { success: false, output: "", errors: [err.message], ms: 0 };
  }
}

// ============================================
// API ENDPOINTS
// ============================================

app.post("/api/compile", rateLimitHttp(25, 10000), async (req, res) => {
  const { code, stdin } = req.body;
  if (typeof code !== "string" || !code.trim()) return res.status(400).json({ error: "Code required" });
  
  if (code.length > MAX_CODE_LENGTH) {
    return res.status(400).json({ error: "Code too long (max 100KB)" });
  }

  if (typeof stdin === "string" && stdin.length > MAX_STDIN_LENGTH) {
    return res.status(400).json({ error: "Input too long" });
  }
  
  const result = await compileAndRun(code, stdin || "");
  res.json(result);
});

app.get("/api/students", requireTeacherAuth, (req, res) => {
  res.json(db.students);
});

app.post("/api/students", rateLimitHttp(30, 10000), (req, res) => {
  const { id, firstName, journalNum, className } = sanitizeStudentPayload(req.body, "");
  if (!id) return res.status(400).json({ error: "id required" });
  
  if (!db.students.find(s => s.id === id)) {
    db.students.push({ id, firstName, journalNum, className, lastSeen: Date.now(), loggedOut: false, loggedOutAt: null });
    saveDatabase();
  } else {
    const student = db.students.find(s => s.id === id);
    if (student) {
      student.firstName = firstName;
      student.journalNum = journalNum;
      student.className = className;
      student.lastSeen = Date.now();
      student.loggedOut = false;
      student.loggedOutAt = null;
      saveDatabase();
    }
  }
  res.json({ success: true });
});

// Get student code - uses folder name based on student data
app.get("/api/student/:id/code", requireTeacherAuth, (req, res) => {
  const studentId = req.params.id;
  // Find student in database to get name
  const student = db.students.find(s => s.id === studentId);
  const firstName = student?.firstName || 'unknown';
  const journalNum = student?.journalNum || '';
  const className = student?.className || '';
  const code = getStudentCode(studentId, firstName, journalNum, className);
  res.json({ studentId, code });
});

// Get student activities
app.get("/api/student/:id/activities", requireTeacherAuth, (req, res) => {
  const studentId = req.params.id;
  const student = db.students.find(s => s.id === studentId);
  const firstName = student?.firstName || 'unknown';
  const journalNum = student?.journalNum || '';
  const className = student?.className || '';
  const activities = getStudentActivities(studentId, firstName, journalNum, className);
  res.json({ studentId, activities });
});

// Get student info
app.get("/api/student/:id/info", requireTeacherAuth, (req, res) => {
  const studentId = req.params.id;
  const student = db.students.find(s => s.id === studentId);
  const firstName = student?.firstName || 'unknown';
  const journalNum = student?.journalNum || '';
  const className = student?.className || '';
  const info = getStudentInfo(studentId, firstName, journalNum, className);
  res.json(info || { id: studentId });
});

app.delete("/api/students/:id", requireTeacherAuth, (req, res) => {
  const studentId = req.params.id;
  db.students = db.students.filter(s => s.id !== studentId);
  if (db.activities[studentId]) {
    delete db.activities[studentId];
  }
  db.submissions = db.submissions.filter(s => s.studentId !== studentId);
  saveDatabase();
  io.emit("student_deleted", { studentId });
  log(`Student deleted: ${studentId}`);
  res.json({ success: true });
});

app.delete("/api/students", requireTeacherAuth, (req, res) => {
  try {
    resetAllStudentsData();

    io.emit("all_students_removed", { at: Date.now() });
    log("All students removed by teacher");
    res.json({ success: true });
  } catch (err) {
    log("Remove all students error:", err.message);
    res.status(500).json({ error: "Remove all students failed" });
  }
});

app.post("/api/students/remove-all", requireTeacherAuth, (req, res) => {
  try {
    resetAllStudentsData();
    io.emit("all_students_removed", { at: Date.now() });
    log("All students removed by teacher (POST)");
    res.json({ success: true });
  } catch (err) {
    log("Remove all students (POST) error:", err.message);
    res.status(500).json({ error: "Remove all students failed" });
  }
});

app.get("/api/activities/:studentId", requireTeacherAuth, (req, res) => {
  const activities = db.activities[req.params.studentId] || [];
  res.json(activities);
});

// Get ALL activities from all students
app.get("/api/activities-all", requireTeacherAuth, (req, res) => {
  const allActivities = [];
  for (const [studentId, activities] of Object.entries(db.activities)) {
    for (const activity of activities) {
      allActivities.push({
        studentId,
        ...activity
      });
    }
  }
  // Sort by timestamp descending
  allActivities.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  res.json(allActivities.slice(0, 500)); // Last 500 activities
});

// Clear activities for offline students
app.post("/api/activities-clear-offline", requireTeacherAuth, (req, res) => {
  const { studentIds } = req.body;
  if (!studentIds || !Array.isArray(studentIds)) {
    return res.status(400).json({ error: "studentIds array required" });
  }
  
  const idsToKeep = new Set(studentIds);
  let removed = 0;
  
  for (const studentId of Object.keys(db.activities)) {
    if (!idsToKeep.has(studentId)) {
      delete db.activities[studentId];
      removed++;
    }
  }
  
  db.students = db.students.filter(s => idsToKeep.has(s.id));
  
  saveDatabase();
  log(`Cleared activities for ${removed} offline students`);
  res.json({ success: true, removed });
});

app.post("/api/database/clear", requireTeacherAuth, (req, res) => {
  try {
    resetAllStudentsData();

    io.emit("database_reset", { at: Date.now() });
    log("Database cleared by teacher");
    res.json({ success: true });
  } catch (err) {
    log("Database clear error:", err.message);
    res.status(500).json({ error: "Database clear failed" });
  }
});

app.get("/api/database/export", requireTeacherAuth, (req, res) => {
  try {
    const payload = {
      exportedAt: Date.now(),
      exportedAtReadable: new Date().toLocaleString("pl-PL"),
      data: db
    };
    const fileName = `backup_database_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    log("Database export error:", err.message);
    res.status(500).json({ error: "Database export failed" });
  }
});

app.post("/api/logout", rateLimitHttp(40, 10000), (req, res) => {
  const studentId = sanitizeStudentId(req.body?.studentId);
  if (!studentId) return res.status(400).json({ error: "studentId required" });
  
  const dbStudent = db.students.find(s => s.id === studentId);
  if (dbStudent) {
    const firstName = dbStudent.firstName || "Uczen";
    const journalNum = dbStudent.journalNum || "";
    const className = dbStudent.className || "";

    // Reset saved code on explicit logout.
    resetStudentCode(studentId, firstName, journalNum, className);

    dbStudent.loggedOut = true;
    dbStudent.loggedOutAt = Date.now();
    saveDatabase();
    io.emit("student_logged_out", { studentId: studentId, firstName });
    io.emit("code_update", {
      studentId,
      firstName,
      journalNum,
      className,
      code: ""
    });
    log(`Student logged out via API: ${studentId}`);
  }
  res.json({ success: true });
});
app.post("/api/activities", rateLimitHttp(80, 10000), (req, res) => {
  const studentId = sanitizeStudentId(req.body?.studentId);
  const studentName = sanitizeDisplayText(req.body?.studentName, "?", 80);
  const activity = sanitizeActivity(req.body?.activity);
  if (!studentId || !activity) return res.status(400).json({ error: "required" });
  
  const entry = { ...activity, studentName };
  
  if (!db.activities[studentId]) db.activities[studentId] = [];
  db.activities[studentId].push(entry);
  
  if (db.activities[studentId].length > MAX_ACTIVITY_LOG_ITEMS) {
    db.activities[studentId] = db.activities[studentId].slice(-MAX_ACTIVITY_KEEP_ITEMS);
  }
  
  saveDatabase();
  res.json({ success: true });
});

app.post("/api/sessions", rateLimitHttp(20, 10000), (req, res) => {
  const { studentId, firstName, lastName, pcInfo, activities } = req.body;
  if (!studentId) return res.status(400).json({ error: "studentId required" });
  
  saveStudentSession(studentId, { studentId, firstName, lastName, pcInfo, activities });
  res.json({ success: true });
});

app.get("/api/log", requireTeacherAuth, (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    res.json(lines.slice(-200));
  } catch (err) {
    res.json([]);
  }
});

app.post("/api/log/clear", requireTeacherAuth, (req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, "");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Could not clear log" });
  }
});

app.get("/api/stats", requireTeacherAuth, (req, res) => {
  const stats = {
    totalStudents: db.students.length,
    totalActivities: Object.values(db.activities).reduce((sum, arr) => sum + arr.length, 0),
    connectedNow: Object.keys(connectedStudents).length,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };
  res.json(stats);
});

// ============================================
// SOCKET.IO
// ============================================

let connectedStudents = {};
const runningProcesses = {};

io.on("connection", (socket) => {
  log(`Client connected: ${socket.id}`);
  const antiCheat = {
    events: [],
    lastWarnAt: 0,
    lastLockAt: 0,
    lastLogoutAt: 0
  };
  const socketRates = {
    activity: { windowStart: 0, count: 0 },
    code: { windowStart: 0, count: 0 },
    compile: { windowStart: 0, count: 0 },
    run: { windowStart: 0, count: 0 },
    input: { windowStart: 0, count: 0 },
    bypass: { windowStart: 0, count: 0 }
  };

  socket.on("register_student", (student) => {
    console.log('[SERVER] register_student RAW:', JSON.stringify(student));
    log(`register_student received: ${JSON.stringify(student)}`);
    const normalized = sanitizeStudentPayload(student, `unknown_${socket.id}`);
    const id = normalized.id;
    const firstName = normalized.firstName;
    const journalNum = normalized.journalNum;
    const className = normalized.className;
    
    console.log('[SERVER] Processed data:', { firstName, journalNum, className });
    
    connectedStudents[socket.id] = {
      id: id,
      firstName: firstName,
      journalNum: journalNum,
      className: className,
      socketId: socket.id,
      connectedAt: Date.now()
    };

    // Keep DB status in sync so logged-out students become active again after reconnect
    const dbStudent = db.students.find(s => s.id === id);
    if (dbStudent) {
      dbStudent.firstName = firstName;
      dbStudent.journalNum = journalNum;
      dbStudent.className = className;
      dbStudent.lastSeen = Date.now();
      dbStudent.loggedOut = false;
      dbStudent.loggedOutAt = null;
    } else {
      db.students.push({
        id,
        firstName,
        journalNum,
        className,
        lastSeen: Date.now(),
        loggedOut: false,
        loggedOutAt: null
      });
    }
    saveDatabase();
    
    io.emit("student_joined", {
      id: socket.id,
      studentId: id,
      firstName: firstName,
      journalNum: journalNum,
      className: className,
      lastSeen: Date.now()
    });
    
    log(`Student registered: ${firstName}`);
    console.log('[SERVER] connectedStudents:', connectedStudents);
    console.log('[SERVER] Emitting student_joined');
  });

  function handleTeacherJoin(payload) {
    const payloadToken = trimText(
      typeof payload === "string" ? payload : (payload?.teacherToken || ""),
      128
    );
    const handshakeToken = trimText(
      socket?.handshake?.auth?.teacherToken || socket?.handshake?.query?.teacherToken || "",
      128
    );
    const teacherToken = payloadToken || handshakeToken;

    if (!isTeacherTokenValid(teacherToken)) {
      socket.emit("auth_error", { reason: "invalid_teacher_token" });
      log(`Teacher auth failed: ${socket.id}`);
      return;
    }
    socket.isTeacher = true;
    log(`Teacher connected: ${socket.id}`);

    const students = Object.values(connectedStudents).map(s => ({
      id: s.socketId || s.id,
      studentId: s.id || s.socketId,
      firstName: (s.firstName && s.firstName !== 'undefined') ? String(s.firstName).trim() : "Uczen",
      journalNum: (s.journalNum && s.journalNum !== 'undefined') ? String(s.journalNum).trim() : "",
      className: (s.className && s.className !== 'undefined') ? String(s.className).trim() : "",
      lastSeen: s.connectedAt || Date.now(),
      socketId: s.socketId || s.id
    }));
    socket.emit("students_list", students);
  }

  socket.on("teacher_join", handleTeacherJoin);
  socket.on("identify_teacher", handleTeacherJoin);

  // Broadcast activity to all teachers and save to file
  socket.on("student_activity", (data) => {
    if (rateLimitBucket(socketRates.activity, 50, 10000)) return;
    const student = connectedStudents[socket.id];
    if (student) {
      const studentId = student.id || socket.id;
      const firstName = (student.firstName && student.firstName !== 'undefined') ? String(student.firstName).trim() : 'Uczen';
      const journalNum = (student.journalNum && student.journalNum !== 'undefined') ? String(student.journalNum).trim() : '';
      const className = (student.className && student.className !== 'undefined') ? String(student.className).trim() : '';
      const studentName = sanitizeDisplayText(data?.studentName, firstName || "Nieznany", 80);
      const activity = sanitizeActivity(data);
      if (!activity) return;
      
      // Save activity to file
      const activities = getStudentActivities(studentId, firstName, journalNum, className);
      activities.push({
        ...activity,
        studentName,
        savedAt: Date.now()
      });
      saveStudentActivities(studentId, activities, firstName, journalNum, className);
      
      // Also save to in-memory DB
      if (!db.activities[studentId]) db.activities[studentId] = [];
      db.activities[studentId].push({ ...activity, studentName, savedAt: Date.now() });
      if (db.activities[studentId].length > MAX_ACTIVITY_LOG_ITEMS) {
        db.activities[studentId] = db.activities[studentId].slice(-MAX_ACTIVITY_KEEP_ITEMS);
      }
      saveDatabase();

      const weight = getAntiCheatWeight(activity);
      if (weight > 0) {
        const now = Date.now();
        antiCheat.events = antiCheat.events.filter((item) => now - item.ts <= ANTI_CHEAT_WINDOW_MS);
        antiCheat.events.push({ ts: now, weight });
        const score = antiCheat.events.reduce((sum, item) => sum + item.weight, 0);

        if (score >= ANTI_CHEAT_LOGOUT_SCORE && now - antiCheat.lastLogoutAt > 25000) {
          antiCheat.lastLogoutAt = now;
          socket.emit("anti_cheat_action", {
            action: "logout",
            score,
            reason: "Zbyt wiele naruszeń zasad w krótkim czasie."
          });

          const dbStudent = db.students.find(s => s.id === studentId);
          if (dbStudent) {
            dbStudent.loggedOut = true;
            dbStudent.loggedOutAt = now;
          }
          resetStudentCode(studentId, firstName, journalNum, className);
          saveDatabase();
          io.emit("student_logged_out", { studentId, firstName });
          io.emit("code_update", { studentId, firstName, journalNum, className, code: "" });
          log(`ANTI-CHEAT logout: ${firstName} (${studentId}) score=${score}`);
          try { socket.disconnect(true); } catch (e) {}
        } else if (score >= ANTI_CHEAT_LOCK_SCORE && now - antiCheat.lastLockAt > 15000) {
          antiCheat.lastLockAt = now;
          socket.emit("anti_cheat_action", {
            action: "lock",
            score,
            durationMs: 180000,
            reason: "Wykryto wysoką aktywność podejrzaną."
          });
          log(`ANTI-CHEAT lock: ${firstName} (${studentId}) score=${score}`);
        } else if (score >= ANTI_CHEAT_WARN_SCORE && now - antiCheat.lastWarnAt > 8000) {
          antiCheat.lastWarnAt = now;
          socket.emit("anti_cheat_action", {
            action: "warn",
            score,
            reason: "Wykryto podejrzane działania."
          });
          log(`ANTI-CHEAT warn: ${firstName} (${studentId}) score=${score}`);
        }
      }
      
      io.emit("activity_update", {
        studentId: studentId,
        firstName: firstName,
        journalNum: journalNum,
        className: className,
        studentName,
        activity
      });
    }
  });

  socket.on("anti_cheat_bypass", (data) => {
    if (rateLimitBucket(socketRates.bypass, 10, 60000)) return;
    const student = connectedStudents[socket.id];
    if (!student) return;

    const studentId = student.id || socket.id;
    const firstName = (student.firstName && student.firstName !== 'undefined') ? String(student.firstName).trim() : 'Uczen';
    const journalNum = (student.journalNum && student.journalNum !== 'undefined') ? String(student.journalNum).trim() : '';
    const className = (student.className && student.className !== 'undefined') ? String(student.className).trim() : '';
    const reason = sanitizeDisplayText(data?.reason, "Wykryto próbę obejścia zabezpieczeń", 180);

    const suspiciousActivity = sanitizeActivity({
      type: "suspicious",
      ts: Date.now(),
      details: {
        reason: `Obejście zabezpieczeń: ${reason}`,
        source: "integrity_monitor",
        ...((data?.details && typeof data.details === "object" && !Array.isArray(data.details)) ? data.details : {})
      }
    });
    if (!suspiciousActivity) return;

    const activities = getStudentActivities(studentId, firstName, journalNum, className);
    activities.push({
      ...suspiciousActivity,
      studentName: firstName,
      savedAt: Date.now()
    });
    saveStudentActivities(studentId, activities, firstName, journalNum, className);

    if (!db.activities[studentId]) db.activities[studentId] = [];
    db.activities[studentId].push({ ...suspiciousActivity, studentName: firstName, savedAt: Date.now() });
    if (db.activities[studentId].length > MAX_ACTIVITY_LOG_ITEMS) {
      db.activities[studentId] = db.activities[studentId].slice(-MAX_ACTIVITY_KEEP_ITEMS);
    }
    saveDatabase();

    antiCheat.events = antiCheat.events.filter((item) => Date.now() - item.ts <= ANTI_CHEAT_WINDOW_MS);
    antiCheat.events.push({ ts: Date.now(), weight: 4 });
    const score = antiCheat.events.reduce((sum, item) => sum + item.weight, 0);

    io.emit("activity_update", {
      studentId,
      firstName,
      journalNum,
      className,
      studentName: firstName,
      activity: suspiciousActivity
    });

    if (score >= ANTI_CHEAT_LOGOUT_SCORE && Date.now() - antiCheat.lastLogoutAt > 25000) {
      antiCheat.lastLogoutAt = Date.now();
      socket.emit("anti_cheat_action", {
        action: "logout",
        score,
        reason: "Wykryto obejście zabezpieczeń po stronie przeglądarki."
      });

      const dbStudent = db.students.find(s => s.id === studentId);
      if (dbStudent) {
        dbStudent.loggedOut = true;
        dbStudent.loggedOutAt = Date.now();
      }
      resetStudentCode(studentId, firstName, journalNum, className);
      saveDatabase();
      io.emit("student_logged_out", { studentId, firstName });
      io.emit("code_update", { studentId, firstName, journalNum, className, code: "" });
      log(`ANTI-CHEAT bypass logout: ${firstName} (${studentId}) score=${score} reason=${reason}`);
      try { socket.disconnect(true); } catch (e) {}
      return;
    }

    if (Date.now() - antiCheat.lastLockAt > 12000) {
      antiCheat.lastLockAt = Date.now();
      socket.emit("anti_cheat_action", {
        action: "lock",
        score,
        durationMs: 300000,
        reason: "Wykryto próbę obchodzenia zabezpieczeń."
      });
    }

    log(`ANTI-CHEAT bypass detected: ${firstName} (${studentId}) score=${score} reason=${reason}`);
  });
  
  socket.on("student_logout", (data) => {
    const student = connectedStudents[socket.id];
    if (student) {
      const studentId = student.id || socket.id;
      const firstName = (student.firstName && student.firstName !== 'undefined') ? String(student.firstName).trim() : 'Uczen';
      const journalNum = (student.journalNum && student.journalNum !== 'undefined') ? String(student.journalNum).trim() : '';
      const className = (student.className && student.className !== 'undefined') ? String(student.className).trim() : '';

      // Reset saved code on logout.
      resetStudentCode(studentId, firstName, journalNum, className);
      
      // Save logout activity
      const activities = getStudentActivities(studentId, firstName, journalNum, className);
      activities.push({
        type: "logout",
        ts: Date.now(),
        details: { reason: "Student wylogował się" },
        studentName: firstName,
        savedAt: Date.now()
      });
      saveStudentActivities(studentId, activities, firstName, journalNum, className);
      
      // Mark student as logged out in database
      const dbStudent = db.students.find(s => s.id === studentId);
      if (dbStudent) {
        dbStudent.loggedOut = true;
        dbStudent.loggedOutAt = Date.now();
        saveDatabase();
      }
      
      io.emit("student_logged_out", {
        studentId: studentId,
        firstName: firstName
      });
      io.emit("code_update", {
        studentId: studentId,
        firstName: firstName,
        journalNum: journalNum,
        className: className,
        code: ""
      });
      
      log(`Student logged out: ${firstName}`);
    }
  });

  // Broadcast task to all students
  socket.on("broadcast_task", (task) => {
    const token = trimText(task?.teacherToken || "", 128);
    if (!socket.isTeacher || !isTeacherTokenValid(token)) return;
    const safeTask = {
      title: sanitizeDisplayText(task?.title, "Zadanie", 160),
      code: typeof task?.code === "string" ? task.code.slice(0, MAX_CODE_LENGTH) : ""
    };
    log(`Teacher broadcasting task: ${safeTask.title}`);
    io.emit("receive_task", safeTask);
  });

  // Broadcast message to all students
  socket.on("broadcast_message", (data) => {
    const token = trimText(data?.teacherToken || "", 128);
    if (!socket.isTeacher || !isTeacherTokenValid(token)) return;
    const safeMessage = sanitizeDisplayText(data?.message, "", 500);
    if (!safeMessage) return;
    log(`Teacher broadcasting message: ${safeMessage}`);
    io.emit("receive_message", { message: safeMessage });
  });

  // Student code update - send to all teachers and save to file
  socket.on("student_code", (data) => {
    if (rateLimitBucket(socketRates.code, 20, 10000)) return;
    const student = connectedStudents[socket.id];
    if (student) {
      const studentId = student.id || socket.id;
      const firstName = (student.firstName && student.firstName !== 'undefined') ? String(student.firstName).trim() : 'Uczen';
      const journalNum = (student.journalNum && student.journalNum !== 'undefined') ? String(student.journalNum).trim() : '';
      const className = (student.className && student.className !== 'undefined') ? String(student.className).trim() : '';
      const code = typeof data?.code === "string" ? data.code.slice(0, MAX_CODE_LENGTH) : "";
      
      // Save code to file
      saveStudentCode(studentId, code, firstName, journalNum, className);
      saveStudentInfo(studentId, {
        id: studentId,
        firstName: student.firstName,
        journalNum: student.journalNum,
        className: student.className,
        lastCodeUpdate: Date.now()
      }, firstName, journalNum, className);
      
      io.emit("code_update", {
        studentId: studentId,
        firstName: student.firstName,
        journalNum: student.journalNum,
        className: student.className,
        code
      });
    }
  });

  socket.on("compile_only", async (data) => {
    if (rateLimitBucket(socketRates.compile, 30, 10000)) {
      socket.emit("compile_result", { jobId: trimText(String(data?.jobId || ""), 120), success: false, rawErrors: "Za dużo żądań kompilacji" });
      return;
    }
    const code = typeof data?.code === "string" ? data.code : "";
    const jobId = trimText(String(data?.jobId || ""), 120);
    
    // Always respond, even if code is empty
    if (!code) {
      socket.emit("compile_result", { jobId, success: false, rawErrors: "Brak kodu" });
      return;
    }
    
    if (code.length > MAX_CODE_LENGTH) {
      socket.emit("compile_result", { jobId, success: false, rawErrors: "Kod zbyt dlugi" });
      return;
    }
    
    try {
      const result = await runOnlineCompiler(code, "");
      
      if (!result || typeof result !== 'object') {
        socket.emit("compile_result", {
          jobId,
          success: false,
          rawErrors: "Nieprawidłowa odpowiedź serwera kompilatora"
        });
        return;
      }
      
      // Check for image property that was causing errors
      if (result.image) {
        console.log('[SERVER] Warning: result contains image data, ignoring');
      }
      
      if (result.error && String(result.error).trim()) {
        socket.emit("compile_result", {
          jobId,
          success: false,
          rawErrors: String(result.error)
        });
      } else if (result.status === "success") {
        socket.emit("compile_result", {
          jobId,
          success: true,
          rawErrors: ""
        });
      } else {
        const errorMsg = result.output || result.message || result.stderr || "Błąd kompilacji";
        socket.emit("compile_result", {
          jobId,
          success: false,
          rawErrors: String(errorMsg).substring(0, 1000)
        });
      }
    } catch(e) {
      console.error('[SERVER] compile_only error:', e.message);
      socket.emit("compile_result", { jobId, success: false, rawErrors: "Błąd połączenia z kompilatorem: " + e.message });
    }
  });

  socket.on("run_interactive", async (data) => {
    if (rateLimitBucket(socketRates.run, 8, 10000)) {
      socket.emit("run_output", { type: "error", data: "Za dużo uruchomień programu" });
      return;
    }
    if (runningProcesses[socket.id]) {
      socket.emit("run_output", { type: "error", data: "Program jest już uruchomiony" });
      return;
    }

    const code = typeof data?.code === "string" ? data.code : "";
    
    if (!code || code.length > MAX_CODE_LENGTH) {
      socket.emit("run_output", { type: "error", data: "Kod zbyt dlugi (max 100KB)" });
      return;
    }
    
    const jobId = `cpp_${Date.now()}`;
    const srcFile = path.join(TEMP_DIR, `${jobId}.cpp`);
    const exeFile = path.join(TEMP_DIR, jobId);
    
    try {
      fs.writeFileSync(srcFile, code);
      
      const compileResult = await new Promise((resolve) => {
        const proc = spawn("g++", ["-o", exeFile, srcFile, "-std=c++17", "-O2"]);
        let done = false;
        let stderr = "";
        const timeout = setTimeout(() => {
          if (done) return;
          done = true;
          try { proc.kill(); } catch (e) {}
          resolve({ code: -2, stderr: "Kompilacja przekroczyła limit czasu" });
        }, MAX_COMPILE_TIME);
        proc.stderr.on("data", d => stderr += d.toString());
        proc.on("close", code => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          resolve({ code, stderr });
        });
        proc.on("error", err => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          resolve({ code: -1, stderr: err.message });
        });
      });
      
      fs.unlinkSync(srcFile);
      
      if (compileResult.code !== 0) {
        socket.emit("run_output", { type: "compile", success: false });
        compileResult.stderr.split("\n").filter(l => l.trim()).slice(0, 10).forEach(err => {
          socket.emit("run_output", { type: "stderr", data: err });
        });
        socket.emit("run_output", { type: "exit", code: 1 });
        socket.emit("run_output", { type: "program_ended" });
        return;
      }
      
      socket.emit("run_output", { type: "compile", success: true });
      
      runningProcesses[socket.id] = { proc: null, done: false };
      
      const proc = spawn(exeFile, []);
      runningProcesses[socket.id].proc = proc;
      
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let outputSize = 0;
      const runtimeTimeout = setTimeout(() => {
        try { proc.kill(); } catch (e) {}
        socket.emit("run_output", { type: "error", data: "Program przekroczył limit czasu (60s)" });
      }, MAX_PROGRAM_RUNTIME);
      
      proc.stdout.on("data", (data) => {
        if (outputSize >= MAX_OUTPUT_SIZE) return;
        outputSize += data.length;
        if (outputSize > MAX_OUTPUT_SIZE) {
          socket.emit("run_output", { type: "error", data: "Przekroczono limit outputu (100KB)" });
          try { proc.kill(); } catch (e) {}
          return;
        }
        const text = data.toString();
        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        lines.forEach(line => socket.emit("run_output", { type: "stdout", data: line }));
      });
      
      proc.stderr.on("data", (data) => {
        if (outputSize >= MAX_OUTPUT_SIZE) return;
        outputSize += data.length;
        if (outputSize > MAX_OUTPUT_SIZE) {
          socket.emit("run_output", { type: "error", data: "Przekroczono limit outputu (100KB)" });
          try { proc.kill(); } catch (e) {}
          return;
        }
        const text = data.toString();
        stderrBuffer += text;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() || "";
        lines.forEach(line => socket.emit("run_output", { type: "stderr", data: line }));
      });
      
      proc.on("close", (code) => {
        clearTimeout(runtimeTimeout);
        if (stdoutBuffer) socket.emit("run_output", { type: "stdout", data: stdoutBuffer });
        if (stderrBuffer) socket.emit("run_output", { type: "stderr", data: stderrBuffer });
        socket.emit("run_output", { type: "exit", code: code || 0 });
        socket.emit("run_output", { type: "program_ended" });
        try { fs.unlinkSync(exeFile); } catch(e) {}
        delete runningProcesses[socket.id];
      });
      
      proc.on("error", (err) => {
        clearTimeout(runtimeTimeout);
        socket.emit("run_output", { type: "error", data: err.message });
        socket.emit("run_output", { type: "program_ended" });
        try { fs.unlinkSync(exeFile); } catch(e) {}
        delete runningProcesses[socket.id];
      });
      
    } catch(e) {
      socket.emit("run_output", { type: "error", data: e.message });
      socket.emit("run_output", { type: "program_ended" });
    }
  });

  socket.on("send_input", (data) => {
    if (rateLimitBucket(socketRates.input, 40, 10000)) {
      socket.emit("run_output", { type: "error", data: "Za dużo danych wejściowych na raz" });
      return;
    }
    const input = typeof data?.input === "string" ? data.input.slice(0, MAX_INPUT_LENGTH) : "";
    const running = runningProcesses[socket.id];
    
    if (!running || !running.proc) {
      socket.emit("run_output", { type: "error", data: "Brak uruchomionego programu" });
      return;
    }
    
    if (running.proc.stdin && running.proc.stdin.writable) {
      try {
        running.proc.stdin.write(input);
        running.proc.stdin.write('\n');
      } catch(e) {
        socket.emit("run_output", { type: "error", data: "Nie mozna wyslac danych: " + e.message });
      }
    } else {
      socket.emit("run_output", { type: "error", data: "Proces nie oczekuje na dane" });
    }
  });

  socket.on("stop_program", () => {
    const running = runningProcesses[socket.id];
    if (running) {
      try {
        if (running.proc.stdin && running.proc.stdin.writable) {
          running.proc.stdin.end();
        }
        running.proc.kill();
        socket.emit("run_output", { type: "program_stopped" });
      } catch(e) {
        socket.emit("run_output", { type: "error", data: "Blad zatrzymania: " + e.message });
      }
      delete runningProcesses[socket.id];
    }
  });

  socket.on("disconnect", () => {
    const student = connectedStudents[socket.id];
    if (student) {
      // Mark student as offline instead of removing
      student.offline = true;
      student.disconnectedAt = Date.now();
      log(`Student disconnected (now offline): ${student.firstName}`);
      io.emit("student_offline", { 
        id: socket.id, 
        studentId: student.id,
        firstName: student.firstName
      });
    }
    
    const running = runningProcesses[socket.id];
    if (running) {
      try {
        if (running.proc.stdin) running.proc.stdin.end();
        running.proc.kill();
      } catch(e) {}
      delete runningProcesses[socket.id];
    }
    
    delete connectedStudents[socket.id];
    log(`Client disconnected: ${socket.id}`);
  });

  // Remove student manually (teacher action)
  socket.on("remove_student", (data) => {
    const token = trimText(data?.teacherToken || "", 128);
    if (!socket.isTeacher || !isTeacherTokenValid(token)) return;
    const { studentId } = data;
    log(`Removing student manually: ${studentId}`);
    
    // Remove from database
    db.students = db.students.filter(s => s.id !== studentId);
    if (db.activities[studentId]) {
      delete db.activities[studentId];
    }
    saveDatabase();
    
    io.emit("student_removed", { studentId });
  });
});

// ============================================
// CLEANUP STALE FILES
// ============================================

setInterval(() => {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach(file => {
      try {
        const stats = fs.statSync(path.join(TEMP_DIR, file));
        if (now - stats.mtimeMs > 3600000) {
          fs.unlinkSync(path.join(TEMP_DIR, file));
        }
      } catch(e) {}
    });
  } catch(e) {}
}, 300000);

// ============================================
// START
// ============================================

process.on("uncaughtException", (err) => {
  log("Uncaught Exception:", err.message);
});

process.on("unhandledRejection", (err) => {
  log("Unhandled Rejection:", err.message);
});

server.listen(PORT, "0.0.0.0", () => {
  if (!RAW_TEACHER_TOKEN) {
    log(`SECURITY WARNING: TEACHER_TOKEN not set. Temporary token for this run: ${TEACHER_TOKEN}`);
  }

  log(`========================================`);
  log(`Server started on port ${PORT}`);
  log(`http://localhost:${PORT}`);
  log(`========================================`);
});
