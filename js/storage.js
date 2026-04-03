// Proste API do przechowywania danych w localStorage.
// Klucze danych:
// - "studentDb" – lista uczniów (tablica obiektów {id, firstName, lastName, lastSeen})
// - "studentActivity" – obiekt mapujący id ucznia -> lista zdarzeń
// - "lastSave" – timestamp ostatniego zapisu

window.Storage = {
  load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.warn("Storage: błąd odczytu", key, err);
      return fallback;
    }
  },
  save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn("Storage: błąd zapisu", key, err);
    }
  },
  remove(key) {
    localStorage.removeItem(key);
  },
  clear() {
    localStorage.clear();
  },
  nextId() {
    return `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  },
};
