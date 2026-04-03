const http = require("http");
const { io } = require("socket.io-client");

const URL = "http://localhost:3000";
const NUM_STUDENTS = 22;
const DURATION = 30000;

let connected = 0;
let messagesReceived = 0;
let errors = 0;

function createStudent(id) {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ["websocket"] });
    let resolved = false;

    socket.on("connect", () => {
      connected++;
      socket.emit("register_student", {
        id: "student_" + id,
        firstName: "Uczen" + id,
        lastName: "Nazwisko" + id
      });

      socket.emit("student_activity", { type: "page_view", page: "home" });
    });

    socket.on("receive_task", () => { messagesReceived++; });
    socket.on("receive_message", () => { messagesReceived++; });
    socket.on("code_update", () => { messagesReceived++; });
    socket.on("activity_update", () => { messagesReceived++; });

    socket.on("connect_error", () => { errors++; if (!resolved) { resolved = true; resolve(); } });
    socket.on("disconnect", () => { if (!resolved) { resolved = true; resolve(); } });

    setTimeout(() => {
      if (!resolved) { resolved = true; socket.disconnect(); resolve(); }
    }, DURATION);
  });
}

function getStats() {
  return new Promise((resolve, reject) => {
    http.get(URL + "/api/stats", (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function main() {
  console.log("=== TEST 20-25 UCZNIOW ===");
  console.log("Tworzenie " + NUM_STUDENTS + " polaczen...");

  const students = [];
  for (let i = 0; i < NUM_STUDENTS; i++) {
    students.push(createStudent(i));
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("Czekam 15s...");
  await new Promise((r) => setTimeout(r, 15000));

  try {
    const stats = await getStats();
    console.log("\n--- STATYSTYKI SERWERA ---");
    console.log("Polaczeni uczniowie:", connected);
    console.log("ConnectedNow:", stats.connectedNow);
    console.log("Czas dzialania:", Math.floor(stats.uptime) + "s");
    console.log("Pamiec RSS:", Math.round(stats.memory.rss / 1024 / 1024) + "MB");
    console.log("Wiadomosci otrzymane:", messagesReceived);
    console.log("Bledy:", errors);
  } catch (e) {
    console.log("Blad pobierania statystyk:", e.message);
  }

  console.log("\nOdlaczanie...");
  await Promise.all(students);
  console.log("KONIEC TESTU");
}

main().catch(console.error);
