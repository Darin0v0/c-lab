# Aplikacja edukacyjna C++ (Uczeń / Nauczyciel)

Aplikacja webowa do pracy na lekcji informatyki: uczeń pisze i uruchamia kod C++, a nauczyciel widzi aktywność i kod uczniów w czasie rzeczywistym.
Działa lokalnie (`localhost`) i w sieci LAN.

## Stack
- Backend: `Node.js`, `Express`, `Socket.IO`
- Frontend: HTML/CSS/JS + `CodeMirror`
- Persistencja: `database.json`, katalog `students_data/`, `sessions/`

## Wymagania
- Node.js 14+ (zalecane 18+)
- npm

## Uruchomienie
1. Instalacja zależności:
```bash
npm install
```

2. Start serwera:
```bash
npm start
```

3. Otwórz aplikację:
- lokalnie: `http://localhost:3000`
- z innego komputera w LAN: `http://ADRES_IP_SERWERA:3000`

## Role
- `Uczeń` (`student.html`): edytor C++, terminal, uruchamianie programu, wysyłanie kodu/aktywności.
- `Nauczyciel` (`teacher.html`): lista uczniów, podgląd kodu, aktywności, operacje administracyjne.

## Najważniejsze funkcje
### Uczeń
- edytor C++ z podświetlaniem składni (`CodeMirror`)
- uruchamianie/stop programu
- automatyczny zapis kodu lokalnie
- rejestracja aktywności (m.in. run, copy/paste, blur/focus, logout)

### Nauczyciel
- podgląd uczniów online/offline w czasie rzeczywistym
- filtrowanie i wyszukiwanie uczniów
- podgląd kodu i aktywności ucznia
- broadcast wiadomości do wszystkich uczniów
- usuwanie pojedynczego ucznia
- usuwanie wszystkich uczniów
- czyszczenie całej bazy danych
- eksport kopii bazy (`/api/database/export`)

## Pliki danych
- `database.json` — główna baza aplikacji
- `students_data/` — zapisane kody i aktywności per uczeń
- `sessions/` — dane sesji uczniów
- `server.log` — logi serwera

## Skrypty npm
- `npm start` — uruchamia serwer (`server.js`)
- `npm test` — uruchamia `load-test.js`
- `npm run load-test` — test obciążeniowy

## Testowanie (smoke)
Przykładowe szybkie sprawdzenie API:
```bash
curl http://127.0.0.1:3000/api/students
curl http://127.0.0.1:3000/api/activities-all
```

## Najczęstsze problemy
- **Nowa funkcja/API nie działa (404)**
  - najczęściej działa stara instancja serwera; zrestartuj `npm start`.
- **Brak połączenia z innego komputera w LAN**
  - sprawdź firewall i czy używasz poprawnego IP serwera.
- **Zmiany stylu nie widać**
  - zrób twarde odświeżenie w przeglądarce (`Ctrl+F5`).
