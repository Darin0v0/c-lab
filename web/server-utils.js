const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DB_FILE = path.join(__dirname, "database.json");
const SESSIONS_DIR = path.join(__dirname, "sessions");
const LOG_FILE = path.join(__dirname, "server.log");
const STUDENTS_DATA_DIR = path.join(__dirname, "students_data");

if (!fs.existsSync(STUDENTS_DATA_DIR)) {
  fs.mkdirSync(STUDENTS_DATA_DIR, { recursive: true });
}

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
}

function resetStudentCode(studentId, firstName, journalNum, className) {
  if (studentId && firstName) {
    try {
      saveStudentCode(studentId, "", firstName, journalNum || "", className || "");
    } catch (e) {}
  }

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

const MAX_CODE_LENGTH = 100000;
const MAX_STDIN_LENGTH = 8000;
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
  if (type === "blur_window" || type === "unload") return 1;
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

module.exports = {
  getStudentFolderName,
  getStudentDir,
  saveStudentCode,
  resetStudentCode,
  getStudentCode,
  saveStudentActivities,
  getStudentActivities,
  saveStudentInfo,
  getStudentInfo,
  trimText,
  sanitizeStudentId,
  sanitizeDisplayText,
  sanitizeActivity,
  sanitizeStudentPayload,
  rateLimitBucket,
  getAntiCheatWeight,
  extractTeacherTokenFromReq,
  isTeacherTokenValid,
  TEACHER_TOKEN,
  STUDENTS_DATA_DIR,
  MAX_CODE_LENGTH,
  MAX_STDIN_LENGTH,
  MAX_ACTIVITY_LOG_ITEMS,
  MAX_ACTIVITY_KEEP_ITEMS
};
