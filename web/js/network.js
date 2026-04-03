const Network = {
  socket: null,
  role: null,
  teacherToken: "",
  queue: [],
  TEACHER_TOKEN_KEY: "teacher_dashboard_token_v1",
  TEACHER_TOKEN_FALLBACK_KEY: "teacher_token",

  normalizeTeacherToken(value) {
    return String(value || "").trim().slice(0, 128);
  },

  ensureTeacherToken(forcePrompt = false) {
    if (this.role !== "teacher") return "";

    if (!forcePrompt) {
      try {
        if (!this.teacherToken) {
          const stored =
            localStorage.getItem(this.TEACHER_TOKEN_KEY) ||
            localStorage.getItem(this.TEACHER_TOKEN_FALLBACK_KEY) ||
            "";
          this.teacherToken = this.normalizeTeacherToken(stored);
        }
      } catch (e) {}
    }

    if (!this.teacherToken || forcePrompt) {
      const provided = prompt("Podaj PIN nauczyciela:");
      const normalized = this.normalizeTeacherToken(provided);
      if (!normalized) return "";
      this.teacherToken = normalized;
      try {
        localStorage.setItem(this.TEACHER_TOKEN_KEY, this.teacherToken);
      } catch (e) {}
    }

    return this.teacherToken;
  },

  clearTeacherToken() {
    this.teacherToken = "";
    try {
      localStorage.removeItem(this.TEACHER_TOKEN_KEY);
      localStorage.removeItem(this.TEACHER_TOKEN_FALLBACK_KEY);
    } catch (e) {}
  },

  async teacherFetch(url, options = {}) {
    const token = this.ensureTeacherToken();
    if (!token) throw new Error("missing_teacher_token");

    const merged = { ...options };
    merged.headers = { ...(options.headers || {}), "x-teacher-token": token };

    const res = await fetch(url, merged);
    if (res.status === 403) {
      this.clearTeacherToken();
    }
    return res;
  },

  init() {
    if (document.body.classList.contains("teacher-page")) {
      this.role = "teacher";
    } else {
      this.role = "student";
    }

    console.log("[Network] Initializing...", this.role);

    this.socket = io();

    this.socket.on("connect", () => {
      console.log("[Network] Connected. ID:", this.socket.id);
      if (this.role === "teacher") {
        const token = this.ensureTeacherToken();
        if (token) {
          this.socket.emit("teacher_join", { teacherToken: token });
        }
      }
      this.processQueue();
      this.syncLocalWithServer();
    });

    this.socket.on("disconnect", () => {
      console.log("[Network] Disconnected");
    });

    this.socket.on("auth_error", (data) => {
      console.warn("[Network] Auth error:", data);
      this.clearTeacherToken();
    });

    this.socket.on("sync_state", (db) => {
      console.log("[Network] Received sync_state:", db);
      if (db.students) {
        Storage.save("studentDb", db.students);
      }
      if (db.activities) {
        Storage.save("studentActivity", db.activities);
      }
      this.triggerUpdate("full");
    });

    this.socket.on("student_update", (students) => {
      console.log("[Network] Received student_update:", students.length);
      Storage.save("studentDb", students);
      this.triggerUpdate("students");
    });

    this.socket.on("activity_update", (data) => {
      const allActivities = Storage.load("studentActivity", {});
      allActivities[data.studentId] = data.activity;
      Storage.save("studentActivity", allActivities);
      this.triggerUpdate("activity", data.studentId);
    });

    // Fallback: Fetch initial state from file (REST API)
    this.fetchDatabase();
  },

  async fetchDatabase() {
    if (this.role !== "teacher") return;
    try {
      const [studentsRes, activitiesRes] = await Promise.all([
        this.teacherFetch("/api/students"),
        this.teacherFetch("/api/activities-all"),
      ]);
      if (!studentsRes.ok || !activitiesRes.ok) {
        throw new Error("Failed to fetch teacher data");
      }
      const students = await studentsRes.json();
      const activityEntries = await activitiesRes.json();
      const activities = {};
      for (const item of Array.isArray(activityEntries) ? activityEntries : []) {
        if (!item || !item.studentId) continue;
        if (!activities[item.studentId]) activities[item.studentId] = [];
        activities[item.studentId].push(item);
      }
      Storage.save("studentDb", Array.isArray(students) ? students : []);
      Storage.save("studentActivity", activities);
      this.triggerUpdate("full");
    } catch (err) {
      console.warn("[Network] REST fetch failed:", err);
    }
  },

  triggerUpdate(type, detailId = null) {
    const event = new CustomEvent("network-update", {
      detail: { type, id: detailId },
    });
    window.dispatchEvent(event);
  },

  processQueue() {
    if (!this.queue.length) return;
    console.log("[Network] Processing queue:", this.queue.length);
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (this.socket && this.socket.connected) {
        this.socket.emit(task.event, task.data);
      }
    }
  },

  emitOrQueue(event, data) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, data);
    } else {
      console.log("[Network] Socket not ready, queuing:", event);
      this.queue.push({ event, data });
    }
  },

  registerStudent(studentData) {
    this.emitOrQueue("register_student", studentData);
  },

  sendActivity(studentId, activityEntry) {
    this.emitOrQueue("log_activity", {
      studentId,
      activity: activityEntry,
    });
  },

  clearData() {
    this.emitOrQueue("clear_data");
  },

  deleteStudent(studentId) {
    this.emitOrQueue("delete_student", studentId);
  },

  syncLocalWithServer() {
    if (this.role === "student") {
      const id = sessionStorage.getItem("studentId");
      const firstName = sessionStorage.getItem("studentFirstName");
      const lastName = sessionStorage.getItem("studentLastName");
      if (id && firstName && lastName) {
        console.log("[Network] Syncing local student identity to server");
        this.registerStudent({ id, firstName, lastName });
      }
    }
  },
};

if (typeof io !== "undefined") {
  Network.init();
} else {
  console.warn("[Network] Socket.IO not loaded.");
}
