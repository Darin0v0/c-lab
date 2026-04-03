const http = require("http");
const { io } = require("socket.io-client");

const SERVER_URL = "http://localhost:3000";
const SOCKET_URL = "http://localhost:3000";

const CONCURRENT_CONNECTIONS = 50;
const REQUESTS_PER_CONNECTION = 10;
const RAMP_UP_TIME = 5000;

let stats = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  totalResponseTime: 0,
  minResponseTime: Infinity,
  maxResponseTime: 0,
  errors: [],
  socketConnections: 0,
  socketMessages: 0,
  socketErrors: 0
};

function makeHttpRequest(method, path, data = null) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const url = new URL(path, SERVER_URL);
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: {
        "Content-Type": "application/json"
      }
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        const responseTime = Date.now() - startTime;
        stats.totalRequests++;
        
        if (res.statusCode >= 200 && res.statusCode < 300) {
          stats.successfulRequests++;
        } else {
          stats.failedRequests++;
          stats.errors.push({ path, status: res.statusCode });
        }
        
        stats.totalResponseTime += responseTime;
        stats.minResponseTime = Math.min(stats.minResponseTime, responseTime);
        stats.maxResponseTime = Math.max(stats.maxResponseTime, responseTime);
        
        resolve({ status: res.statusCode, responseTime, body });
      });
    });

    req.on("error", (err) => {
      const responseTime = Date.now() - startTime;
      stats.totalRequests++;
      stats.failedRequests++;
      stats.errors.push({ path, error: err.message });
      stats.minResponseTime = Math.min(stats.minResponseTime, responseTime);
      resolve({ status: 0, responseTime, error: err.message });
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

function createSocketConnection(id) {
  return new Promise((resolve) => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      reconnection: false
    });

    let resolved = false;

    socket.on("connect", () => {
      stats.socketConnections++;
      
      socket.emit("register_student", {
        id: `load_test_student_${id}`,
        firstName: `LoadTest${id}`,
        lastName: "Student"
      });

      socket.emit("student_activity", {
        type: "page_view",
        data: { page: "test" }
      });

      socket.emit("student_code", {
        code: "#include <iostream>\nint main() { return 0; }"
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.disconnect();
          resolve();
        }
      }, 1000);
    });

    socket.on("connect_error", () => {
      stats.socketErrors++;
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });

    socket.on("disconnect", () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.disconnect();
        resolve();
      }
    }, 3000);
  });
}

async function runHttpLoadTest() {
  console.log("\n--- HTTP Load Test ---");
  
  const testCode = `#include <bits/stdc++.h>
int main() {
    std::vector<int> v = {1, 2, 3, 4, 5};
    for (auto x : v) std::cout << x << " ";
    return 0;
}`;

  const requests = [];
  
  for (let i = 0; i < CONCURRENT_CONNECTIONS; i++) {
    for (let j = 0; j < REQUESTS_PER_CONNECTION; j++) {
      const requestType = Math.random();
      
      if (requestType < 0.3) {
        requests.push(makeHttpRequest("GET", "/api/stats"));
      } else if (requestType < 0.5) {
        requests.push(makeHttpRequest("GET", "/api/students"));
      } else if (requestType < 0.7) {
        requests.push(makeHttpRequest("GET", "/api/activities-all"));
      } else if (requestType < 0.9) {
        requests.push(makeHttpRequest("POST", "/api/compile", { 
          code: testCode,
          stdin: ""
        }));
      } else {
        requests.push(makeHttpRequest("POST", "/api/activities", {
          studentId: `load_test_${i}`,
          studentName: `Student ${i}`,
          activity: { type: "test", timestamp: Date.now() }
        }));
      }
    }
  }

  await Promise.all(requests);
}

async function runSocketLoadTest() {
  console.log("\n--- Socket.IO Load Test ---");
  
  const connections = [];
  for (let i = 0; i < CONCURRENT_CONNECTIONS; i++) {
    connections.push(createSocketConnection(i));
    await new Promise(r => setTimeout(r, RAMP_UP_TIME / CONCURRENT_CONNECTIONS));
  }
  
  await Promise.all(connections);
}

function printResults() {
  console.log("\n========== LOAD TEST RESULTS ==========");
  
  const avgResponseTime = stats.totalRequests > 0 
    ? (stats.totalResponseTime / stats.totalRequests).toFixed(2) 
    : 0;
  
  console.log("\nHTTP Endpoints:");
  console.log(`  Total Requests:        ${stats.totalRequests}`);
  console.log(`  Successful:            ${stats.successfulRequests}`);
  console.log(`  Failed:                ${stats.failedRequests}`);
  console.log(`  Avg Response Time:     ${avgResponseTime}ms`);
  console.log(`  Min Response Time:     ${stats.minResponseTime === Infinity ? 0 : stats.minResponseTime}ms`);
  console.log(`  Max Response Time:     ${stats.maxResponseTime}ms`);
  console.log(`  Success Rate:         ${((stats.successfulRequests / stats.totalRequests) * 100).toFixed(2)}%`);
  
  console.log("\nSocket.IO:");
  console.log(`  Connections Made:      ${stats.socketConnections}`);
  console.log(`  Errors:                ${stats.socketErrors}`);
  
  if (stats.errors.length > 0) {
    console.log("\nErrors (first 10):");
    stats.errors.slice(0, 10).forEach(e => {
      console.log(`  - ${e.path || 'Unknown'}: ${e.error || e.status}`);
    });
  }
  
  console.log("\n========================================\n");
}

async function main() {
  console.log("========================================");
  console.log("       LOAD TEST SUITE");
  console.log(`  Target: ${SERVER_URL}`);
  console.log(`  Concurrent Connections: ${CONCURRENT_CONNECTIONS}`);
  console.log(`  Requests per Connection: ${REQUESTS_PER_CONNECTION}`);
  console.log("========================================");

  const startTime = Date.now();

  try {
    await Promise.all([
      runHttpLoadTest(),
      runSocketLoadTest()
    ]);
  } catch (e) {
    console.error("Test error:", e.message);
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log(`\nTotal Test Duration: ${totalTime.toFixed(2)}s`);
  
  printResults();
  
  const successRate = stats.totalRequests > 0 
    ? (stats.successfulRequests / stats.totalRequests) * 100 
    : 0;
  
  process.exit(successRate >= 95 ? 0 : 1);
}

main();
