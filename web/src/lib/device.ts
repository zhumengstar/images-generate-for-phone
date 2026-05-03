"use client";

const CLIENT_ID_STORAGE_KEY = "images-generate-client-id";

function createClientId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const randomPart = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0"),
  ).join("");
  return `${Date.now().toString(16)}-${randomPart}`;
}

function getStoredClientId() {
  if (typeof window === "undefined") {
    return "server";
  }

  try {
    const storedClientId = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (storedClientId) {
      return storedClientId;
    }

    const nextClientId = createClientId();
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, nextClientId);
    return nextClientId;
  } catch {
    return createClientId();
  }
}

async function sha256(value: string) {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }

  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getDeviceFingerprint() {
  if (typeof window === "undefined") {
    return "server";
  }

  const clientId = getStoredClientId();
  const fingerprintSource = {
    clientId,
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      colorDepth: window.screen.colorDepth,
      pixelDepth: window.screen.pixelDepth,
      devicePixelRatio: window.devicePixelRatio,
    },
  };

  const hashedFingerprint = await sha256(JSON.stringify(fingerprintSource));
  return hashedFingerprint || `client-${clientId}`;
}
