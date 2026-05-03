"use client";

import localforage from "localforage";

export type AuthRole = "admin" | "user";

export type StoredAuthSession = {
  key: string;
  role: AuthRole;
  subjectId: string;
  name: string;
};

export const AUTH_KEY_STORAGE_KEY = "images_generate_remote_image_auth_key";
export const AUTH_SESSION_STORAGE_KEY = "images_generate_remote_image_auth_session";
const AUTH_SESSION_SYNC_STORAGE_KEY = `${AUTH_SESSION_STORAGE_KEY}:sync`;
const LEGACY_APP_STORAGE_NAME = String.fromCharCode(99, 104, 97, 116, 103, 112, 116, 50, 97, 112, 105);
const LEGACY_AUTH_KEY_STORAGE_KEY = `${LEGACY_APP_STORAGE_NAME}_remote_image_auth_key`;
const LEGACY_AUTH_SESSION_STORAGE_KEY = `${LEGACY_APP_STORAGE_NAME}_remote_image_auth_session`;

const authStorage = localforage.createInstance({
  name: "images-generate",
  storeName: "auth",
});

const legacyAuthStorage = localforage.createInstance({
  name: LEGACY_APP_STORAGE_NAME,
  storeName: "auth",
});

function normalizeSession(value: unknown, fallbackKey = ""): StoredAuthSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredAuthSession>;
  const key = String(candidate.key || fallbackKey || "").trim();
  const role = candidate.role === "admin" || candidate.role === "user" ? candidate.role : null;
  if (!role) {
    return null;
  }

  return {
    key,
    role,
    subjectId: String(candidate.subjectId || "").trim(),
    name: String(candidate.name || "").trim(),
  };
}

function readSyncAuthSession() {
  try {
    return normalizeSession(JSON.parse(window.localStorage.getItem(AUTH_SESSION_SYNC_STORAGE_KEY) || "null"));
  } catch {
    return null;
  }
}

function writeSyncAuthSession(session: StoredAuthSession) {
  try {
    window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, session.key);
    window.localStorage.setItem(AUTH_SESSION_SYNC_STORAGE_KEY, JSON.stringify(session));
  } catch {}
}

function clearSyncAuthSession() {
  try {
    window.localStorage.removeItem(AUTH_KEY_STORAGE_KEY);
    window.localStorage.removeItem(AUTH_SESSION_SYNC_STORAGE_KEY);
  } catch {}
}

export function getSyncStoredAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }
  return readSyncAuthSession();
}

export function getDefaultRouteForRole(role: AuthRole) {
  return "/image";
}

export async function getStoredAuthKey() {
  if (typeof window === "undefined") {
    return "";
  }
  const syncKey = String(window.localStorage.getItem(AUTH_KEY_STORAGE_KEY) || "").trim();
  if (syncKey) {
    return syncKey;
  }
  const storedKey = String((await authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY)) || "").trim();
  if (storedKey) {
    const storedSession = await authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY);
    const normalizedSession = normalizeSession(storedSession, storedKey);
    if (normalizedSession) {
      writeSyncAuthSession(normalizedSession);
    } else {
      try {
        window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, storedKey);
      } catch {}
    }
    return storedKey;
  }
  const legacyKey = String((await legacyAuthStorage.getItem<string>(LEGACY_AUTH_KEY_STORAGE_KEY)) || "").trim();
  if (legacyKey) {
    await authStorage.setItem(AUTH_KEY_STORAGE_KEY, legacyKey);
    try {
      window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, legacyKey);
    } catch {}
    return legacyKey;
  }
  return "";
}

export async function getStoredAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }

  const syncSession = readSyncAuthSession();
  if (syncSession) {
    return syncSession;
  }

  let [storedKey, storedSession] = await Promise.all([
    authStorage.getItem<string>(AUTH_KEY_STORAGE_KEY),
    authStorage.getItem<StoredAuthSession>(AUTH_SESSION_STORAGE_KEY),
  ]);
  if (!String(storedKey || "").trim() && !storedSession) {
    [storedKey, storedSession] = await Promise.all([
      legacyAuthStorage.getItem<string>(LEGACY_AUTH_KEY_STORAGE_KEY),
      legacyAuthStorage.getItem<StoredAuthSession>(LEGACY_AUTH_SESSION_STORAGE_KEY),
    ]);
  }

  const normalizedSession = normalizeSession(storedSession, String(storedKey || ""));
  if (normalizedSession) {
    if (normalizedSession.key !== String(storedKey || "").trim()) {
      await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key);
    }
    writeSyncAuthSession(normalizedSession);
    return normalizedSession;
  }

  if (String(storedKey || "").trim()) {
    await clearStoredAuthSession();
  }
  const defaultAuthKey = "";
  if (defaultAuthKey) {
    return {
      key: defaultAuthKey,
      role: "user" as const,
      subjectId: "default-user",
      name: "默认用户",
    };
  }
  return null;
}

export async function setStoredAuthSession(session: StoredAuthSession) {
  const normalizedSession = normalizeSession(session);
  if (!normalizedSession) {
    await clearStoredAuthSession();
    return;
  }

  await Promise.all([
    authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedSession.key),
    authStorage.setItem(AUTH_SESSION_STORAGE_KEY, normalizedSession),
  ]);
  writeSyncAuthSession(normalizedSession);
}

export async function setStoredAuthKey(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  if (!normalizedAuthKey) {
    await clearStoredAuthSession();
    return;
  }
  try {
    window.localStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedAuthKey);
  } catch {}
  await authStorage.setItem(AUTH_KEY_STORAGE_KEY, normalizedAuthKey);
}

export async function clearStoredAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  clearSyncAuthSession();
  await Promise.all([
    authStorage.removeItem(AUTH_KEY_STORAGE_KEY),
    authStorage.removeItem(AUTH_SESSION_STORAGE_KEY),
    legacyAuthStorage.removeItem(LEGACY_AUTH_KEY_STORAGE_KEY),
    legacyAuthStorage.removeItem(LEGACY_AUTH_SESSION_STORAGE_KEY),
  ]);
}

export async function clearStoredAuthKey() {
  await clearStoredAuthSession();
}
