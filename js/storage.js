const KEYS = {
  places: "okinawa-trip.places",
  settings: "okinawa-trip.settings",
  schedule: "okinawa-trip.schedule",
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const store = {
  getPlaces() { return load(KEYS.places, []); },
  setPlaces(places) { save(KEYS.places, places); },

  getSettings() {
    return load(KEYS.settings, {
      startDate: "",
      days: 5,
      base: { name: "", address: "", lat: null, lng: null },
      dayStart: "09:00",
      dayEnd: "19:00",
    });
  },
  setSettings(settings) { save(KEYS.settings, settings); },

  getSchedule() { return load(KEYS.schedule, null); },
  setSchedule(schedule) { save(KEYS.schedule, schedule); },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
