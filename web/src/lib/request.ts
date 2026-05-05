import axios, {AxiosError, type AxiosRequestConfig} from "axios";

import webConfig from "@/constants/common-env";
import {getDeviceFingerprint} from "@/lib/device";
import {clearStoredAuthSession, getStoredAuthKey} from "@/store/auth";

type RequestConfig = AxiosRequestConfig & {
    redirectOnUnauthorized?: boolean;
    skipAuth?: boolean;
};

type ErrorPayload = {
    detail?: string | { error?: string | { message?: string } };
    error?: string | { message?: string };
    message?: string;
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

function resolveApiBaseUrl() {
    const configured = webConfig.apiUrl.replace(/\/$/, "");
    if (!configured || typeof window === "undefined") {
        return configured;
    }
    try {
        const currentHost = window.location.hostname;
        const configuredUrl = new URL(configured, window.location.origin);
        const isLocalPage =
            currentHost === "localhost" ||
            currentHost === "127.0.0.1" ||
            currentHost === "::1" ||
            currentHost.startsWith("192.168.") ||
            currentHost.startsWith("10.") ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(currentHost);
        return isLocalPage || configuredUrl.host === window.location.host ? "" : configured;
    } catch {
        return "";
    }
}

const request = axios.create({
    baseURL: resolveApiBaseUrl(),
    timeout: 15000,
});

request.interceptors.request.use(async (config) => {
    const nextConfig = {...config};
    const headers = {...(nextConfig.headers || {})} as Record<string, string>;
    if (!headers["X-Device-Fingerprint"]) {
        headers["X-Device-Fingerprint"] = await getDeviceFingerprint();
    }
    const skipAuth = (nextConfig as RequestConfig).skipAuth === true;
    const authKey = skipAuth ? "" : await getStoredAuthKey();
    if (authKey && !headers.Authorization) {
        headers.Authorization = `Bearer ${authKey}`;
    }
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-expect-error
    nextConfig.headers = headers;
    return nextConfig;
});

request.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<ErrorPayload>) => {
        const status = error.response?.status;
        const shouldRedirect = (error.config as RequestConfig | undefined)?.redirectOnUnauthorized !== false;
        if (status === 401 && shouldRedirect && typeof window !== "undefined") {
            // Avoid redirect loop — only redirect if not already on /login
            if (!window.location.pathname.startsWith("/login")) {
                await clearStoredAuthSession();
                window.location.replace("/login");
                // Return a never-resolving promise to prevent further error handling
                // while the browser navigates away
                return new Promise(() => {});
            }
        }

        const payload = error.response?.data;
        const message =
            errorMessageFromValue(payload?.detail) ||
            errorMessageFromValue(payload?.error) ||
            translateKnownErrorMessage(payload?.message || "") ||
            translateKnownErrorMessage(error.message || "") ||
            `请求失败 (${status || 500})`;
        return Promise.reject(new Error(message));
    },
);

type RequestOptions = {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    redirectOnUnauthorized?: boolean;
    skipAuth?: boolean;
};

export async function httpRequest<T>(path: string, options: RequestOptions = {}) {
    const {method = "GET", body, headers, redirectOnUnauthorized = true, skipAuth = false} = options;
    const config: RequestConfig = {
        url: path,
        method,
        data: body,
        headers,
        redirectOnUnauthorized,
        skipAuth,
    };
    const response = await request.request<T>(config);
    return response.data;
}
