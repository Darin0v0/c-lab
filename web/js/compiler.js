/**
 * Compiler Module - C++ Code Compilation & Execution
 */

(function(global) {
    let socket = null;
    let isRunning = false;
    let isCompiling = false;
    let statusBadge = null;
    let terminalOutput = null;
    let terminalInput = null;
    let runBtn = null;
    let runBtn2 = null;
    let stopBtn = null;
    let stopBtn2 = null;
    let onActivityCallback = null;
    let onTaskReceivedCallback = null;
    let onMessageReceivedCallback = null;

    function setRunning(running) {
        isRunning = running;
        if (runBtn) {
            runBtn.disabled = running || isCompiling;
            if (!running && !isCompiling) runBtn.textContent = "▶ Uruchom";
        }
        if (runBtn2) runBtn2.disabled = running;
        if (stopBtn) stopBtn.style.display = running ? "inline-block" : "none";
        if (stopBtn2) {
            if (running) stopBtn2.classList.add("active");
            else stopBtn2.classList.remove("active");
        }
        if (terminalInput) {
            terminalInput.disabled = !running;
            if (running) terminalInput.focus();
        }
        updateStdinPrompt();
    }

    function setCompiling(compiling) {
        isCompiling = compiling;
        if (runBtn) {
            runBtn.textContent = compiling ? "⏳ Kompilacja..." : "▶ Uruchom";
            runBtn.disabled = compiling || isRunning;
        }
    }

    function updateStdinPrompt() {
        const promptIcon = document.getElementById("promptIcon");
        if (promptIcon) {
            if (isRunning) {
                promptIcon.textContent = "stdin: ";
                promptIcon.className = "prompt waiting";
            } else {
                promptIcon.textContent = "stdin: ";
                promptIcon.className = "prompt";
            }
        }
    }

    function print(text, type) {
        type = type || "stdout";
        if (!terminalOutput) return;
        const line = document.createElement("div");
        line.className = "line " + type;
        line.textContent = text;
        terminalOutput.appendChild(line);
        terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

    function addCursor() {
        if (!terminalOutput) return;
        const cursor = document.createElement('span');
        cursor.className = 'cursor';
        terminalOutput.appendChild(cursor);
    }

    function addActivity(type, details) {
        if (onActivityCallback) {
            onActivityCallback(type, details);
        }
    }

    function stopProgram() {
        if (socket?.connected) {
            socket.emit("stop_program");
        }
    }

    function runCode(code) {
        if (window.StudentSecurity && window.StudentSecurity.canRun === false) {
            print("[ANTI-CHEAT] Uruchamianie zablokowane. Włącz pełny ekran i poczekaj na zdjęcie blokady.", "error");
            addActivity("suspicious", { reason: "Próba uruchomienia kodu poza trybem egzaminu" });
            return;
        }
        if (isRunning) {
            print("[INFO] Program jest już uruchomiony!", "system");
            return;
        }
        if (!socket?.connected) {
            print("╔═══════════════════════════════════════╗", "error");
            print("║     BLAD POLACZENIA                    ║", "error");
            print("╚═══════════════════════════════════════╝", "error");
            print("  Serwer nie odpowiada.", "error");
            return;
        }
        
        if (!code?.trim()) {
            print("[BLAD] Brak kodu do skompilowania!", "error");
            return;
        }
        
        setRunning(true);
        setCompiling(true);
        
        if (terminalInput) {
            terminalInput.value = "";
            terminalInput.disabled = false;
            terminalInput.focus();
        }
        
        print("", "stdout");
        print("[INFO] Wpisz dane i nacisnij Enter...", "system");
        socket.emit("run_interactive", { code });
        addActivity("run", { success: true });
    }

    function sendInteractiveInput(input) {
        if (!isRunning) {
            print("> BLAD: Program nie jest uruchomiony", "error");
            return;
        }
        
        if (!socket?.connected) {
            print("> BLAD: Brak polaczenia", "error");
            return;
        }
        
        if (!input) {
            print("> Wpisz dane i nacisnij Enter", "system");
            return;
        }
        
        if (terminalInput) {
            terminalInput.value = "";
            terminalInput.focus();
        }
        
        print("> " + input, "stdin");
        socket.emit("send_input", { input: input });
    }

    function showHelp() {
        const helpText = `
═══════════════════════════════════════
         SKRÓTY KLAWIATUROWE          
═══════════════════════════════════════
  F5          - Uruchom program
  Ctrl+S      - Zapisz kod
  Ctrl+Z      - Cofnij
  Ctrl+Y      - Ponów
  Ctrl+Plus   - Zwieksz czcionke
  Ctrl+Minus  - Zmniejsz czcionke
  Tab         - Wcięcie (4 spacje)
  Ctrl+/      - Zakomentuj wiersz
  Ctrl+D      - Duplikuj wiersz
  Alt+Up/Down - Przesun wiersz
  Ctrl+F      - Szukaj
═══════════════════════════════════════
`;
        print(helpText, "system");
    }

    function initSocket(options = {}) {
        const serverUrl = window.location.origin;
        onActivityCallback = options.onActivity || null;
        onTaskReceivedCallback = options.onTaskReceived || null;
        onMessageReceivedCallback = options.onMessageReceived || null;
        
        if (typeof io === "undefined") {
            console.error("Socket.IO not available!");
            return null;
        }
        
        socket = io(serverUrl, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000
        });
        
        function handleConnect() {
            console.log("✓ Socket CONNECTED:", socket.id);
            if (statusBadge) {
                statusBadge.textContent = "Online";
                statusBadge.className = "status online";
            }
            if (options.onConnect) options.onConnect();
        }
        
        if (socket.connected) {
            handleConnect();
        }
        
        socket.on("connect", handleConnect);
        
        socket.on("connect_error", function (err) {
            console.error("✗ Socket connection error:", err.message);
        });
        
        socket.on("disconnect", function () {
            console.log("✗ Socket DISCONNECTED");
            if (statusBadge) {
                statusBadge.textContent = "Offline";
                statusBadge.className = "status offline";
            }
            if (isRunning) {
                print("> UTRACONO POLACZENIE Z SERWEREM!", "error");
                setRunning(false);
                setCompiling(false);
            }
        });

        socket.on("compile_result", function (data) {
            if (data.jobId && data.jobId.startsWith("live_")) {
                const compileStatus = document.getElementById("compileStatus");
                if (compileStatus) {
                    compileStatus.textContent = data.success ? "✓" : "✗";
                    compileStatus.style.color = data.success ? "#00ff00" : "#ff3333";
                }
            }
        });

        socket.on("run_output", function (data) {
            switch (data.type) {
                case "compile":
                    if (data.success) {
                        setCompiling(false);
                        print("[  OK  ] Kompilacja zakonczona", "success");
                        addActivity("compile", { success: true, errors: 0 });
                    } else {
                        setCompiling(false);
                        print("", "system");
                        print("╔═══════════════════════════════════════╗", "error");
                        print("║         BLAD KOMPILACJI               ║", "error");
                        print("╚═══════════════════════════════════════╝", "error");
                        print("", "error");
                        addActivity("compile", { success: false });
                        
                        const rawErrors = data.rawErrors || data.raw || (data.errors ? data.errors.join('\n') : '');
                        if (rawErrors) {
                            const lines = rawErrors.split('\n');
                            lines.forEach(function(line) {
                                if (line.trim() && !line.startsWith('^') && !line.startsWith('|')) {
                                    print("  " + line, "error");
                                }
                            });
                        }
                        
                        print("", "system");
                        setRunning(false);
                    }
                    break;
                case "stdout":
                    if (data.data) {
                        data.data.split("\n").forEach(function (l) {
                            print(l || "", "stdout");
                        });
                    }
                    break;
                case "stderr":
                    if (data.data) {
                        data.data.split("\n").forEach(function (l) {
                            print("[RUN ERROR] " + l, "error");
                        });
                    }
                    break;
                case "exit":
                    print("", "system");
                    print("═══════════════════════════════", "divider");
                    if (data.code === 0) {
                        print("[SUKCES] Program zakonczyl sie poprawnie", "success");
                    } else if (data.code === -2) {
                        print("[TIMEOUT] Program przekroczył limit czasu!", "error");
                    } else {
                        print("[BLAD " + data.code + "] Błąd wykonania programu", "error");
                    }
                    print("═══════════════════════════════", "divider");
                    print("", "system");
                    addCursor();
                    setRunning(false);
                    setCompiling(false);
                    break;
                case "error":
                    print("", "system");
                    print("╔═══════════════════════════════════════╗", "error");
                    print("║         BLAD WYKONANIA                 ║", "error");
                    print("╚═══════════════════════════════════════╝", "error");
                    print("  " + data.data, "error");
                    print("", "system");
                    addCursor();
                    setRunning(false);
                    setCompiling(false);
                    break;
                case "program_ended":
                    setRunning(false);
                    setCompiling(false);
                    break;
                case "program_stopped":
                    print("", "system");
                    print("[STOP] Program zostal zatrzymany przez uzytkownika", "warning");
                    print("", "system");
                    setRunning(false);
                    setCompiling(false);
                    addCursor();
                    break;
            }
        });

        socket.on("receive_task", function(task) {
            print("", "system");
            print("═══════════════════════════════", "divider");
            print("📝 NOWE ZADANIE OD NAUCZYCIELA!", "success");
            print("Tytul: " + task.title, "system");
            print("Tresc:", "system");
            print(task.code, "stdout");
            if (task.hint) {
                print("", "system");
                print("💡 Wskazowka: " + task.hint, "warning");
            }
            print("═══════════════════════════════", "divider");
            
            if (onTaskReceivedCallback) {
                onTaskReceivedCallback(task);
            }
        });

        socket.on("receive_message", function(data) {
            print("", "system");
            print("═══════════════════════════════", "divider");
            print("📢 WIADOMOSC OD NAUCZYCIELA:", "warning");
            print(data.message, "stdout");
            print("═══════════════════════════════", "divider");
            addActivity("message_received", { message: data.message });
            addCursor();
            
            if (onMessageReceivedCallback) {
                onMessageReceivedCallback(data.message);
            }
        });

        return socket;
    }

    function initCompiler(elements, options = {}) {
        terminalOutput = elements.terminalOutput;
        terminalInput = elements.terminalInput;
        runBtn = elements.runBtn;
        runBtn2 = elements.runBtn2;
        statusBadge = elements.statusBadge;
        stopBtn = document.getElementById("stopBtn");
        stopBtn2 = document.getElementById("stopBtn2");

        if (runBtn) {
            runBtn.addEventListener("click", () => {
                const code = localStorage.getItem('student_code') || '';
                runCode(code, null);
            });
        }
        if (runBtn2) {
            runBtn2.addEventListener("click", () => {
                const code = localStorage.getItem('student_code') || '';
                runCode(code, null);
            });
        }

        if (stopBtn) {
            stopBtn.addEventListener("click", stopProgram);
        }

        if (terminalInput) {
            terminalInput.addEventListener("keydown", function (e) {
                if (e.key === "Enter" && isRunning) {
                    e.preventDefault();
                    sendInteractiveInput(this.value);
                    this.value = "";
                }
            });
        }

        document.addEventListener("keydown", function (e) {
            if (e.key === "F5") {
                e.preventDefault();
                const code = localStorage.getItem('student_code') || '';
                runCode(code, null);
            }
            if (e.ctrlKey && e.key === "h") {
                e.preventDefault();
                showHelp();
            }
        });

        initSocket(options);

        return {
            runCode,
            sendInteractiveInput,
            stopProgram,
            isRunning: () => isRunning,
            isCompiling: () => isCompiling,
            getSocket: () => socket
        };
    }

    global.Compiler = {
        initCompiler,
        initSocket,
        runCode,
        sendInteractiveInput,
        stopProgram,
        getSocket: () => socket
    };
    
})(window);
