import { httpRequest } from "@/lib/request";
import { getDeviceFingerprint } from "@/lib/device";
import { getStoredAuthKey } from "@/store/auth";

export type AccountType = "Free" | "Plus" | "ProLite" | "Pro" | "Team";
export type AccountStatus = "正常" | "限流" | "异常" | "禁用";
export type ImageModel = "gpt-image-2" | "codex-gpt-image-2";
export type AuthRole = "admin" | "user";

export type Account = {
  id: string;
  access_token: string;
  type: AccountType;
  status: AccountStatus;
  quota: number;
  imageQuotaUnknown?: boolean;
  email?: string | null;
  user_id?: string | null;
  limits_progress?: Array<{
    feature_name?: string;
    remaining?: number;
    reset_after?: string;
  }>;
  default_model_slug?: string | null;
  restoreAt?: string | null;
  success: number;
  fail: number;
  lastUsedAt: string | null;
};

type AccountListResponse = {
  items: Account[];
};

type AccountMutationResponse = {
  items: Account[];
  added?: number;
  skipped?: number;
  removed?: number;
  refreshed?: number;
  errors?: Array<{ access_token: string; error: string }>;
};

type AccountRefreshResponse = {
  items: Account[];
  refreshed: number;
  errors: Array<{ access_token: string; error: string }>;
};

type AccountUpdateResponse = {
  item: Account;
  items: Account[];
};

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  refresh_account_interval_minute?: number | string;
  image_retention_days?: number | string;
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  log_levels?: string[];
  [key: string]: unknown;
};

export type ManagedImage = {
  path?: string;
  name: string;
  date: string;
  size: number;
  url: string;
  created_at: string;
};

export type SystemLog = {
  time: string;
  type: "call" | "account" | string;
  summary?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ImageResponse = {
  created: number;
  data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  ip_quota?: {
    user_id?: string;
    name?: string;
    type?: "guest" | "user" | "admin";
    ip: string;
    fingerprint: string;
    limit: number;
    remaining: number;
  };
};

export type IpQuotaResponse = {
  user_id?: string;
  name?: string;
  type?: "guest" | "user" | "admin";
  ip: string;
  fingerprint: string;
  limit: number;
  remaining: number;
};

export type ImageShareLinkResponse = {
  code: string;
  created_at?: string;
  share_path: string;
};

export type ImageShareRedeemResponse = {
  awarded: boolean;
  message: string;
  ip_quota?: IpQuotaResponse;
};

export type ImageTask = {
  id: string;
  status: "queued" | "running" | "success" | "error";
  mode: "generate" | "edit";
  model?: ImageModel;
  size?: string;
  created_at: string;
  updated_at: string;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: string;
};

type PromptPolishResponse = {
  text: string;
  model?: string;
};

type ImageTaskListResponse = {
  items: ImageTask[];
  missing_ids: string[];
};

export type LoginResponse = {
  ok: boolean;
  version: string;
  role: AuthRole;
  subject_id: string;
  name: string;
  token?: string;
  ip?: string;
  fingerprint?: string;
  device_registered?: boolean;
};

export type UserKey = {
  id: string;
  name: string;
  role: "user";
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
};

export type WebUser = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "user" | "guest";
  created_at: string | null;
  last_used_at: string | null;
  active_sessions: number;
  device_count: number;
  used_total: number;
  quota_limit: number;
  remaining_total: number;
  password_saved: boolean;
  device_usages: Array<{
    device: string;
    used: number;
    remaining: number;
  }>;
};

export type WebUserDefaultQuotaLimits = {
  user_image_quota_limit: number;
  guest_image_quota_limit: number;
};

export type WebUsersResponse = {
  items: WebUser[];
  default_quota_limits: WebUserDefaultQuotaLimits;
};

export type RegisterConfig = {
  enabled: boolean;
  mail: {
    request_timeout: number;
    wait_timeout: number;
    wait_interval: number;
    providers: Array<Record<string, unknown>>;
  };
  proxy: string;
  total: number;
  threads: number;
  mode: "total" | "quota" | "available";
  target_quota: number;
  target_available: number;
  check_interval: number;
  stats: {
    job_id?: string;
    success: number;
    fail: number;
    done: number;
    running: number;
    threads: number;
    elapsed_seconds?: number;
    avg_seconds?: number;
    success_rate?: number;
    current_quota?: number;
    current_available?: number;
    started_at?: string;
    updated_at?: string;
    finished_at?: string;
  };
  logs?: Array<{
    time: string;
    text: string;
    level: string;
  }>;
};

function translateKnownErrorMessage(message: string): string {
  const text = message.trim();
  const lower = text.toLowerCase();
  if (!text) {
    return "";
  }
  if (lower === "network error" || lower === "failed to fetch" || lower.includes("load failed")) {
    return "网络连接失败，请检查服务是否正常运行";
  }
  if (lower.includes("timeout")) {
    return "请求超时，请稍后重试";
  }
  if (lower.includes("this device is already bound")) {
    return "当前设备已绑定其他用户，无法继续登录";
  }
  if (lower.includes("username or password is invalid")) {
    return "用户名或密码错误";
  }
  if (lower.includes("username and password are required")) {
    return "请输入用户名和密码";
  }
  if (lower.includes("username or password is too long")) {
    return "用户名或密码过长";
  }
  if (lower.includes("authorization is invalid")) {
    return "登录状态已失效，请重新登录";
  }
  if (lower.startsWith("request failed with status code")) {
    return "请求失败，请稍后重试";
  }
  return text;
}

function errorMessageFromValue(value: unknown): string {
  if (typeof value === "string") {
    return translateKnownErrorMessage(value);
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const item = value as { error?: unknown; message?: unknown };
  if (typeof item.message === "string") {
    return item.message;
  }
  return errorMessageFromValue(item.error);
}

export async function login(authKey: string, credentials?: { username: string; password: string }) {
  const normalizedAuthKey = String(authKey || "").trim();
  const deviceFingerprint = await getDeviceFingerprint();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Device-Fingerprint": deviceFingerprint,
  };
  if (normalizedAuthKey) {
    headers.Authorization = `Bearer ${normalizedAuthKey}`;
  }
  const response = await fetch("/auth/login", {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify({
      device_fingerprint: deviceFingerprint,
      ...(credentials ? { username: credentials.username, password: credentials.password } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `登录失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as LoginResponse;
}

export async function fetchAccounts() {
  return httpRequest<AccountListResponse>("/api/accounts");
}

export async function createAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "POST",
    body: { tokens },
  });
}

export async function deleteAccounts(tokens: string[]) {
  return httpRequest<AccountMutationResponse>("/api/accounts", {
    method: "DELETE",
    body: { tokens },
  });
}

export async function refreshAccounts(accessTokens: string[]) {
  return httpRequest<AccountRefreshResponse>("/api/accounts/refresh", {
    method: "POST",
    body: { access_tokens: accessTokens },
  });
}

export async function updateAccount(
  accessToken: string,
  updates: {
    type?: AccountType;
    status?: AccountStatus;
    quota?: number;
  },
) {
  return httpRequest<AccountUpdateResponse>("/api/accounts/update", {
    method: "POST",
    body: {
      access_token: accessToken,
      ...updates,
    },
  });
}

export async function generateImage(prompt: string, model?: ImageModel, size?: string) {
  const authKey = await getStoredAuthKey();
  const deviceFingerprint = await getDeviceFingerprint();
  const response = await fetch("/api/ip-limited/images/generations", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": deviceFingerprint,
    },
    body: JSON.stringify({
        prompt,
        ...(model ? { model } : {}),
        ...(size ? { size } : {}),
        n: 1,
        response_format: "url",
        client_device_fingerprint: deviceFingerprint,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `生成失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as ImageResponse;
}

export async function fetchIpQuota() {
  const authKey = await getStoredAuthKey();
  const response = await fetch("/api/ip-limited/quota", {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": await getDeviceFingerprint(),
    },
  });
  if (!response.ok) {
    throw new Error(`读取 IP 额度失败 (${response.status})`);
  }
  return (await response.json()) as IpQuotaResponse;
}

export async function refundIpQuota(count = 1) {
  const authKey = await getStoredAuthKey();
  const response = await fetch("/api/ip-limited/quota/refund", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": await getDeviceFingerprint(),
    },
    body: JSON.stringify({ count }),
  });
  if (!response.ok) {
    throw new Error(`退回 IP 额度失败 (${response.status})`);
  }
  return (await response.json()) as IpQuotaResponse;
}

export async function createImageShareLink() {
  const authKey = await getStoredAuthKey();
  const response = await fetch("/api/ip-limited/share-link", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": await getDeviceFingerprint(),
    },
    body: JSON.stringify({}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `创建分享链接失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as ImageShareLinkResponse;
}

export async function redeemImageShareLink(code: string) {
  const authKey = await getStoredAuthKey();
  const response = await fetch("/api/ip-limited/share-link/redeem", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": await getDeviceFingerprint(),
    },
    body: JSON.stringify({ code }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `领取分享奖励失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as ImageShareRedeemResponse;
}

export async function polishImagePrompt(prompt: string, mode: "generate" | "edit" = "generate") {
  const authKey = await getStoredAuthKey();
  const deviceFingerprint = await getDeviceFingerprint();
  const response = await fetch("/api/ip-limited/prompt-polish", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": deviceFingerprint,
    },
    body: JSON.stringify({ prompt, mode }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `AI润色失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as PromptPolishResponse;
}

export async function editImage(files: File | File[], prompt: string, model?: ImageModel, size?: string, count = 1) {
  const authKey = await getStoredAuthKey();
  const deviceFingerprint = await getDeviceFingerprint();
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  formData.append("n", String(Math.min(2, Math.max(1, Math.floor(count) || 1))));
  formData.append("response_format", "url");

  const response = await fetch("/api/ip-limited/images/edits", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": deviceFingerprint,
    },
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `图片编辑失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as ImageResponse;
}

export async function createImageGenerationTask(clientTaskId: string, prompt: string, model?: ImageModel, size?: string) {
  const authKey = await getStoredAuthKey();
  const deviceFingerprint = await getDeviceFingerprint();
  const response = await fetch("/api/ip-limited/image-tasks/generations", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": deviceFingerprint,
    },
    body: JSON.stringify({
      client_task_id: clientTaskId,
      prompt,
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `创建生成任务失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as ImageTask;
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
) {
  const authKey = await getStoredAuthKey();
  const deviceFingerprint = await getDeviceFingerprint();
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("client_task_id", clientTaskId);
  formData.append("prompt", prompt);
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }

  const response = await fetch("/api/ip-limited/image-tasks/edits", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": deviceFingerprint,
    },
    body: formData,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      errorMessageFromValue(payload.detail) ||
      errorMessageFromValue(payload.error) ||
      translateKnownErrorMessage(String(payload.message || "")) ||
      `创建编辑任务失败 (${response.status})`;
    throw new Error(message);
  }
  return payload as ImageTask;
}

export async function fetchImageTasks(ids: string[]) {
  const authKey = await getStoredAuthKey();
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  }
  const response = await fetch(`/api/ip-limited/image-tasks${params.toString() ? `?${params.toString()}` : ""}`, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Authorization: authKey ? `Bearer ${authKey}` : "",
      "X-Device-Fingerprint": await getDeviceFingerprint(),
    },
  });
  if (!response.ok) {
    throw new Error(`读取图片任务失败 (${response.status})`);
  }
  return (await response.json()) as ImageTaskListResponse;
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

export async function fetchManagedImages(filters: { start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: ManagedImage[]; groups: Array<{ date: string; items: ManagedImage[] }> }>(
    `/api/images${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

export async function deleteManagedImages(body: { paths?: string[]; start_date?: string; end_date?: string; all_matching?: boolean }) {
  return httpRequest<{ removed: number }>("/api/images/delete", { method: "POST", body });
}

export async function fetchSystemLogs(filters: { type?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: SystemLog[] }>(`/api/logs${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function fetchUserKeys() {
  return httpRequest<{ items: UserKey[] }>("/api/auth/users");
}

export async function fetchWebUsers() {
  return httpRequest<WebUsersResponse>("/api/web-users");
}

export async function updateWebUserQuota(userId: string, quotaLimit: number) {
  return httpRequest<WebUsersResponse>(`/api/web-users/${encodeURIComponent(userId)}/quota`, {
    method: "POST",
    body: { quota_limit: quotaLimit },
  });
}

export async function updateWebUserDefaultQuotas(limits: WebUserDefaultQuotaLimits) {
  return httpRequest<WebUsersResponse>("/api/web-users/default-quotas", {
    method: "POST",
    body: limits,
  });
}

export async function deleteWebUser(userId: string) {
  return httpRequest<WebUsersResponse>(`/api/web-users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function createUserKey(name: string) {
  return httpRequest<{ item: UserKey; key: string; items: UserKey[] }>("/api/auth/users", {
    method: "POST",
    body: { name },
  });
}

export async function updateUserKey(keyId: string, updates: { enabled?: boolean; name?: string }) {
  return httpRequest<{ item: UserKey; items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteUserKey(keyId: string) {
  return httpRequest<{ items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "DELETE",
  });
}

export async function fetchRegisterConfig() {
  return httpRequest<{ register: RegisterConfig }>("/api/register");
}

export async function updateRegisterConfig(updates: Partial<RegisterConfig>) {
  return httpRequest<{ register: RegisterConfig }>("/api/register", {
    method: "POST",
    body: updates,
  });
}

export async function startRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/start", { method: "POST" });
}

export async function stopRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/stop", { method: "POST" });
}

export async function resetRegister() {
  return httpRequest<{ register: RegisterConfig }>("/api/register/reset", { method: "POST" });
}

// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

export type CPAPool = {
  id: string;
  name: string;
  base_url: string;
  import_job?: CPAImportJob | null;
};

export type CPARemoteFile = {
  name: string;
  email: string;
};

export type CPAImportJob = {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  total: number;
  completed: number;
  added: number;
  skipped: number;
  refreshed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
};

export async function fetchCPAPools() {
  return httpRequest<{ pools: CPAPool[] }>("/api/cpa/pools");
}

export async function createCPAPool(pool: { name: string; base_url: string; secret_key: string }) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>("/api/cpa/pools", {
    method: "POST",
    body: pool,
  });
}

export async function updateCPAPool(
  poolId: string,
  updates: { name?: string; base_url?: string; secret_key?: string },
) {
  return httpRequest<{ pool: CPAPool; pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteCPAPool(poolId: string) {
  return httpRequest<{ pools: CPAPool[] }>(`/api/cpa/pools/${poolId}`, {
    method: "DELETE",
  });
}

export async function fetchCPAPoolFiles(poolId: string) {
  return httpRequest<{ pool_id: string; files: CPARemoteFile[] }>(`/api/cpa/pools/${poolId}/files`);
}

export async function startCPAImport(poolId: string, names: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`, {
    method: "POST",
    body: { names },
  });
}

export async function fetchCPAPoolImportJob(poolId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/cpa/pools/${poolId}/import`);
}

// ── Sub2API ────────────────────────────────────────────────────────

export type Sub2APIServer = {
  id: string;
  name: string;
  base_url: string;
  email: string;
  has_api_key: boolean;
  group_id: string;
  import_job?: CPAImportJob | null;
};

export type Sub2APIRemoteAccount = {
  id: string;
  name: string;
  email: string;
  plan_type: string;
  status: string;
  expires_at: string;
  has_refresh_token: boolean;
};

export type Sub2APIRemoteGroup = {
  id: string;
  name: string;
  description: string;
  platform: string;
  status: string;
  account_count: number;
  active_account_count: number;
};

export async function fetchSub2APIServers() {
  return httpRequest<{ servers: Sub2APIServer[] }>("/api/sub2api/servers");
}

export async function createSub2APIServer(server: {
  name: string;
  base_url: string;
  email: string;
  password: string;
  api_key: string;
  group_id: string;
}) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>("/api/sub2api/servers", {
    method: "POST",
    body: server,
  });
}

export async function updateSub2APIServer(
  serverId: string,
  updates: {
    name?: string;
    base_url?: string;
    email?: string;
    password?: string;
    api_key?: string;
    group_id?: string;
  },
) {
  return httpRequest<{ server: Sub2APIServer; servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "POST",
    body: updates,
  });
}

export async function fetchSub2APIServerGroups(serverId: string) {
  return httpRequest<{ server_id: string; groups: Sub2APIRemoteGroup[] }>(
    `/api/sub2api/servers/${serverId}/groups`,
  );
}

export async function deleteSub2APIServer(serverId: string) {
  return httpRequest<{ servers: Sub2APIServer[] }>(`/api/sub2api/servers/${serverId}`, {
    method: "DELETE",
  });
}

export async function fetchSub2APIServerAccounts(serverId: string) {
  return httpRequest<{ server_id: string; accounts: Sub2APIRemoteAccount[] }>(
    `/api/sub2api/servers/${serverId}/accounts`,
  );
}

export async function startSub2APIImport(serverId: string, accountIds: string[]) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`, {
    method: "POST",
    body: { account_ids: accountIds },
  });
}

export async function fetchSub2APIImportJob(serverId: string) {
  return httpRequest<{ import_job: CPAImportJob | null }>(`/api/sub2api/servers/${serverId}/import`);
}

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
