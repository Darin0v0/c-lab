const fs = require("fs");
const path = require("path");
const {
  getStudentFolderName,
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
  MAX_STDIN_LENGTH
} = require("./server-utils");

const TEST_DIR = path.join(STUDENTS_DATA_DIR, "__test__");

function cleanup() {
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  } catch (e) {}
}

beforeAll(() => cleanup());
afterAll(() => cleanup());

describe("trimText", () => {
  test("zwraca pusty string dla nie-stringów", () => {
    expect(trimText(null)).toBe("");
    expect(trimText(undefined)).toBe("");
    expect(trimText(123)).toBe("");
    expect(trimText({})).toBe("");
  });

  test("usuwa kontrolne znaki", () => {
    expect(trimText("hello\x00world")).toBe("helloworld");
    expect(trimText("test\n\r\t")).toBe("test");
  });

  test("obcina do max długości", () => {
    expect(trimText("abcdefgh", 5)).toBe("abcde");
    expect(trimText("abcd", 10)).toBe("abcd");
  });

  test("trimuje białe znaki", () => {
    expect(trimText("  hello  ")).toBe("hello");
  });
});

describe("sanitizeStudentId", () => {
  test("zwraca pusty string dla null/undefined", () => {
    expect(sanitizeStudentId(null)).toBe("");
    expect(sanitizeStudentId(undefined)).toBe("");
  });

  test("usuwa niedozwolone znaki", () => {
    expect(sanitizeStudentId("student_123")).toBe("student_123");
    expect(sanitizeStudentId("student@123!")).toBe("student123");
    expect(sanitizeStudentId("abc-def_ghi")).toBe("abc-def_ghi");
  });

  test("obcina do 64 znaków", () => {
    const long = "a".repeat(100);
    expect(sanitizeStudentId(long).length).toBe(64);
  });

  test("zwraca fallback dla pustego", () => {
    expect(sanitizeStudentId("", "default")).toBe("default");
  });
});

describe("sanitizeDisplayText", () => {
  test("zwraca fallback dla null/undefined", () => {
    expect(sanitizeDisplayText(null, "default")).toBe("default");
    expect(sanitizeDisplayText(undefined, "fallback")).toBe("fallback");
  });

  test("poprawna sanitizacja polskich znaków", () => {
    expect(sanitizeDisplayText("Jan Kowalski")).toBe("Jan Kowalski");
    expect(sanitizeDisplayText("Łódź")).toBe("Łódź");
  });

  test("obcina do max długości", () => {
    const long = "a".repeat(200);
    expect(sanitizeDisplayText(long, "", 50).length).toBe(50);
  });
});

describe("sanitizeActivity", () => {
  test("zwraca null dla nieprawidłowych danych", () => {
    expect(sanitizeActivity(null)).toBe(null);
    expect(sanitizeActivity(undefined)).toBe(null);
    expect(sanitizeActivity("string")).toBe(null);
    expect(sanitizeActivity([1, 2, 3])).toBe(null);
  });

  test("zwraca dozwolony typ aktywności", () => {
    const result = sanitizeActivity({ type: "view", ts: Date.now() });
    expect(result.type).toBe("view");
  });

  test("zwraca suspicious dla niedozwolonego typu", () => {
    const result = sanitizeActivity({ type: "hack", ts: Date.now() });
    expect(result.type).toBe("suspicious");
  });

  test("sanityzuje details z liczbami i booleanami", () => {
    const result = sanitizeActivity({
      type: "view",
      ts: 1234567890,
      details: {
        count: 42,
        active: true,
        name: "test"
      }
    });
    expect(result.details.count).toBe(42);
    expect(result.details.active).toBe(true);
    expect(result.details.name).toBe("test");
  });

  test("obcina timestamp do teraz dla nieprawidłowego ts", () => {
    const before = Date.now();
    const result = sanitizeActivity({ type: "view", ts: "invalid" });
    const after = Date.now();
    expect(result.ts).toBeGreaterThanOrEqual(before);
    expect(result.ts).toBeLessThanOrEqual(after);
  });
});

describe("sanitizeStudentPayload", () => {
  test("sanityzuje wszystkie pola studenta", () => {
    const student = {
      id: "student_123",
      firstName: "Jan",
      journalNum: "1",
      className: "1A"
    };
    const result = sanitizeStudentPayload(student, "default");
    expect(result.id).toBe("student_123");
    expect(result.firstName).toBe("Jan");
    expect(result.journalNum).toBe("1");
    expect(result.className).toBe("1A");
  });

  test("używa fallback dla brakujących pól", () => {
    const result = sanitizeStudentPayload({}, "fallback_id");
    expect(result.id).toBe("fallback_id");
    expect(result.firstName).toBe("Uczen");
    expect(result.journalNum).toBe("");
    expect(result.className).toBe("");
  });
});

describe("rateLimitBucket", () => {
  test("resetuje licznik po upływie czasu", () => {
    const bucket = { windowStart: 0, count: 0 };
    expect(rateLimitBucket(bucket, 5, 1000)).toBe(false);
    expect(rateLimitBucket(bucket, 5, 1000)).toBe(false);
    
    bucket.windowStart = Date.now() - 2000;
    expect(rateLimitBucket(bucket, 5, 1000)).toBe(false);
    expect(bucket.count).toBe(1);
  });

  test("zwraca true gdy limit przekroczony", () => {
    const bucket = { windowStart: Date.now(), count: 5 };
    expect(rateLimitBucket(bucket, 5, 1000)).toBe(true);
  });
});

describe("getAntiCheatWeight", () => {
  test("zwraca 0 dla null/undefined", () => {
    expect(getAntiCheatWeight(null)).toBe(0);
    expect(getAntiCheatWeight(undefined)).toBe(0);
  });

  test("zwraca 2 dla paste", () => {
    expect(getAntiCheatWeight({ type: "paste" })).toBe(2);
  });

  test("zwraca 2 dla right_click", () => {
    expect(getAntiCheatWeight({ type: "right_click" })).toBe(2);
  });

  test("zwraca 1 dla blur_window", () => {
    expect(getAntiCheatWeight({ type: "blur_window" })).toBe(1);
  });

  test("zwraca 4 dla suspicious z devtools", () => {
    expect(getAntiCheatWeight({ type: "suspicious", details: { reason: "devtools open" } })).toBe(4);
  });

  test("zwraca 3 dla suspicious z wklej", () => {
    expect(getAntiCheatWeight({ type: "suspicious", details: { reason: "wklejono" } })).toBe(3);
  });

  test("zwraca 0 dla nieznanych typów", () => {
    expect(getAntiCheatWeight({ type: "unknown" })).toBe(0);
  });
});

describe("extractTeacherTokenFromReq", () => {
  test("pobiera token z x-teacher-token", () => {
    const req = { headers: { "x-teacher-token": "secret123" } };
    expect(extractTeacherTokenFromReq(req)).toBe("secret123");
  });

  test("pobiera token z Authorization Bearer", () => {
    const req = { headers: { authorization: "Bearer token456" } };
    expect(extractTeacherTokenFromReq(req)).toBe("token456");
  });

  test("pobiera token z query", () => {
    const req = { headers: {}, query: { teacherToken: "queryToken" } };
    expect(extractTeacherTokenFromReq(req)).toBe("queryToken");
  });

  test("pobiera token z body", () => {
    const req = { headers: {}, body: { teacherToken: "bodyToken" } };
    expect(extractTeacherTokenFromReq(req)).toBe("bodyToken");
  });

  test("zwraca pusty string gdy brak tokenu", () => {
    const req = { headers: {} };
    expect(extractTeacherTokenFromReq(req)).toBe("");
  });
});

describe("isTeacherTokenValid", () => {
  test("zwraca false dla pustego tokenu", () => {
    expect(isTeacherTokenValid("")).toBe(false);
  });

  test("zwraca true dla prawidłowego tokenu", () => {
    expect(isTeacherTokenValid(TEACHER_TOKEN)).toBe(true);
  });

  test("zwraca false dla nieprawidłowego tokenu", () => {
    expect(isTeacherTokenValid("wrong_token")).toBe(false);
  });
});

describe("getStudentFolderName", () => {
  test("tworzy folder z imieniem i danymi", () => {
    const result = getStudentFolderName("Jan", "1", "1A");
    expect(result).toBe("jan_1a_1");
  });

  test("twrzy folder tylko z imieniem", () => {
    const result = getStudentFolderName("Anna", "", "");
    expect(result).toBe("anna");
  });

  test("zwraca unknown dla pustego imienia", () => {
    expect(getStudentFolderName("", "1", "1A")).toBe("unknown");
    expect(getStudentFolderName(null, "1", "1A")).toBe("unknown");
    expect(getStudentFolderName(undefined, "1", "1A")).toBe("unknown");
  });

  test("obsługuje polskie znaki", () => {
    const result = getStudentFolderName("Łukasz", "2", "2B");
    expect(result).toBe("łukasz_2b_2");
  });
});

describe("student code operations", () => {
  const testStudentId = "__test_student__";
  const testFirstName = "TestStudent";

  test("zapisuje i odczytuje kod studenta", () => {
    const code = "#include <iostream>\nint main() { return 0; }";
    saveStudentCode(testStudentId, code, testFirstName, "", "");
    
    const readCode = getStudentCode(testStudentId, testFirstName, "", "");
    expect(readCode).toBe(code);
  });

  test("resetStudentCode zeruje kod", () => {
    saveStudentCode(testStudentId, "some code", testFirstName, "", "");
    resetStudentCode(testStudentId, testFirstName, "", "");
    
    const readCode = getStudentCode(testStudentId, testFirstName, "", "");
    expect(readCode).toBe("");
  });

  test("getStudentCode zwraca pusty string dla nieistniejącego studenta", () => {
    const result = getStudentCode("nonexistent", "Unknown", "", "");
    expect(result).toBe("");
  });
});

describe("student activities operations", () => {
  const testStudentId = "__test_activities__";
  const testFirstName = "TestActivities";

  test("zapisuje i odczytuje aktywności", () => {
    const activities = [
      { type: "view", ts: Date.now(), details: {} },
      { type: "run", ts: Date.now(), details: {} }
    ];
    saveStudentActivities(testStudentId, activities, testFirstName, "", "");
    
    const readActivities = getStudentActivities(testStudentId, testFirstName, "", "");
    expect(readActivities).toEqual(activities);
  });

  test("getStudentActivities zwraca pustą tablicę dla nieistniejącego", () => {
    const result = getStudentActivities("nonexistent", "Unknown", "", "");
    expect(result).toEqual([]);
  });
});

describe("student info operations", () => {
  const testStudentId = "__test_info__";
  const testFirstName = "TestInfo";

  test("zapisuje i odczytuje info studenta", () => {
    const info = {
      id: testStudentId,
      firstName: testFirstName,
      lastSeen: Date.now()
    };
    saveStudentInfo(testStudentId, info, testFirstName, "", "");
    
    const readInfo = getStudentInfo(testStudentId, testFirstName, "", "");
    expect(readInfo.id).toBe(testStudentId);
    expect(readInfo.firstName).toBe(testFirstName);
  });

  test("getStudentInfo zwraca null dla nieistniejącego", () => {
    const result = getStudentInfo("nonexistent", "Unknown", "", "");
    expect(result).toBe(null);
  });
});

describe("stałe", () => {
  test("MAX_CODE_LENGTH to 100000", () => {
    expect(MAX_CODE_LENGTH).toBe(100000);
  });

  test("MAX_STDIN_LENGTH to 8000", () => {
    expect(MAX_STDIN_LENGTH).toBe(8000);
  });

  test("TEACHER_TOKEN jest stringiem", () => {
    expect(typeof TEACHER_TOKEN).toBe("string");
    expect(TEACHER_TOKEN.length).toBeGreaterThan(0);
  });
});
