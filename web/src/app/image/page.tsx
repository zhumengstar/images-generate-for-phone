"use client";

import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, History, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageResults, type ImageLightboxItem } from "@/app/image/components/image-results";
import { ImageSidebar } from "@/app/image/components/image-sidebar";
import { ImageLightbox } from "@/components/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  createImageEditTask,
  createImageGenerationTask,
  fetchImageTasks,
  fetchIpQuota,
  polishImagePrompt,
  redeemImageShareLink,
  refundIpQuota,
  type ImageResponse,
  type ImageTask,
  type IpQuotaResponse,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";
import {
  clearImageConversations,
  deleteImageConversation,
  listImageConversations,
  saveImageConversation,
  saveImageConversations,
  type ImageConversation,
  type ImageConversationMode,
  type ImageTurn,
  type ImageTurnStatus,
  type StoredImage,
  type StoredReferenceImage,
} from "@/store/image-conversations";

const ACTIVE_CONVERSATION_STORAGE_KEY = "images-generate:image_active_conversation_id";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "images-generate:image_sidebar_collapsed";
const TOP_INFO_COLLAPSED_STORAGE_KEY = "images-generate:image_top_info_collapsed";
const IMAGE_SIZE_STORAGE_KEY = "images-generate:image_last_size";
const LEGACY_IMAGE_STORAGE_PREFIX = String.fromCharCode(99, 104, 97, 116, 103, 112, 116, 50, 97, 112, 105);
const LEGACY_ACTIVE_CONVERSATION_STORAGE_KEY = `${LEGACY_IMAGE_STORAGE_PREFIX}:image_active_conversation_id`;
const LEGACY_IMAGE_SIZE_STORAGE_KEY = `${LEGACY_IMAGE_STORAGE_PREFIX}:image_last_size`;
const DEFAULT_IMAGE_SIZE = "1:1";
const MOBILE_SHELL_TOP_HEIGHT = 48;
const DESKTOP_MAX_CONCURRENT_IMAGE_TASKS = 2;
const MOBILE_MAX_CONCURRENT_IMAGE_TASKS = 1;
const MAX_QUEUED_IMAGE_TASKS = 4;

function clampImageCount(value: string) {
  return String(Math.min(2, Math.max(1, Math.floor(Number(value) || 1))));
}
const activeImageTaskIds = new Set<string>();

function buildConversationTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}...`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatIpQuota(quota: IpQuotaResponse | null) {
  if (!quota) {
    return "--/5";
  }
  return quota.limit < 0 ? "不限" : `${quota.remaining}/${quota.limit}`;
}

function formatIpQuotaType(quota: IpQuotaResponse | null) {
  if (quota?.type === "admin") {
    return "管理员";
  }
  return quota?.type === "user" ? "用户" : "访客";
}

function formatIpQuotaName(quota: IpQuotaResponse | null) {
  const name = String(quota?.name || "").trim();
  return name || formatIpQuotaType(quota);
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, fileName: string, mimeType?: string) {
  const [header, content] = dataUrl.split(",", 2);
  const matchedMimeType = header.match(/data:(.*?);base64/)?.[1];
  const binary = atob(content || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], fileName, { type: mimeType || matchedMimeType || "image/png" });
}

function buildReferenceImageFromResult(image: StoredImage, fileName: string): StoredReferenceImage | null {
  if (!image.b64_json) {
    return null;
  }

  return {
    name: fileName,
    type: "image/png",
    dataUrl: `data:image/png;base64,${image.b64_json}`,
  };
}

async function fetchImageAsFile(url: string, fileName: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error("读取结果图失败");
  }
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve(dataUrl.split(",", 2)[1] || "");
    };
    reader.onerror = () => reject(new Error("读取图片数据失败"));
    reader.readAsDataURL(blob);
  });
}

async function recallImageResult(image: ImageResponse["data"][number]) {
  if (image.b64_json) {
    return image;
  }
  if (!image.url) {
    throw new Error("接口没有返回图片数据");
  }

  const response = await fetch(image.url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("图片召回失败");
  }
  const blob = await response.blob();
  return {
    ...image,
    b64_json: await blobToBase64(blob),
  };
}

async function buildReferenceImageFromStoredImage(image: StoredImage, fileName: string) {
  const direct = buildReferenceImageFromResult(image, fileName);
  if (direct) {
    return {
      referenceImage: direct,
      file: dataUrlToFile(direct.dataUrl, direct.name, direct.type),
    };
  }

  if (!image.url) {
    return null;
  }
  const file = await fetchImageAsFile(image.url, fileName);
  return {
    referenceImage: {
      name: file.name,
      type: file.type || "image/png",
      dataUrl: await readFileAsDataUrl(file),
    },
    file,
  };
}

function taskDataToStoredImage(image: StoredImage, task: ImageTask): StoredImage {
  if (task.status === "success") {
    const first = task.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return {
        ...image,
        taskId: task.id,
        status: "error",
        error: "未返回图片数据",
      };
    }
    return {
      ...image,
      taskId: task.id,
      status: "success",
      b64_json: first.b64_json,
      url: first.url,
      revised_prompt: first.revised_prompt,
      error: undefined,
    };
  }

  if (task.status === "error") {
    return {
      ...image,
      taskId: task.id,
      status: "error",
      error: task.error || "生成失败",
    };
  }

  return {
    ...image,
    taskId: task.id,
    status: "loading",
    error: undefined,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown, fallback = "生成图片失败") {
  return error instanceof Error ? error.message : fallback;
}

function isRecoverableTaskSyncError(error: unknown) {
  const message = getErrorMessage(error, "").toLowerCase();
  return (
    !message ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("load failed") ||
    message.includes("请求失败") ||
    message.includes("创建编辑任务失败") ||
    message.includes("创建生成任务失败") ||
    message.includes("读取图片任务失败") ||
    message.includes("读取图像任务失败")
  );
}

async function waitForImageTask(taskId: string, timeoutMs = 600000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const taskList = await fetchImageTasks([taskId]);
      const task = taskList.items.find((item) => item.id === taskId);
      if (task?.status === "success" || task?.status === "error") {
        return task;
      }
    } catch {
      // A refresh, tab restore, or brief network hiccup should not turn a
      // server-side background task into a permanent failed image.
    }
    await sleep(1500);
  }
  return null;
}

function pickFallbackConversationId(conversations: ImageConversation[]) {
  const activeConversation = conversations.find((conversation) =>
    conversation.turns.some((turn) => turn.status === "queued" || turn.status === "generating"),
  );
  return activeConversation?.id ?? conversations[0]?.id ?? null;
}

function sortImageConversations(conversations: ImageConversation[]) {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function runWhenIdle(callback: () => void) {
  if (typeof window === "undefined") {
    callback();
    return;
  }
  const requestIdleCallback = (
    window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (requestIdleCallback) {
    requestIdleCallback(callback, { timeout: 1800 });
    return;
  }
  window.setTimeout(callback, 300);
}

function getMaxConcurrentImageTasks() {
  if (typeof window !== "undefined" && window.innerWidth < 640) {
    return MOBILE_MAX_CONCURRENT_IMAGE_TASKS;
  }
  return DESKTOP_MAX_CONCURRENT_IMAGE_TASKS;
}

function hasLoadingTurn(conversation: ImageConversation, status?: ImageTurnStatus) {
  return conversation.turns.some(
    (turn) =>
      (!status || turn.status === status) &&
      (turn.status === "queued" || turn.status === "generating") &&
      turn.images.some((image) => image.status === "loading" && !activeImageTaskIds.has(getImageTaskKey(conversation.id, turn.id, image.id))),
  );
}

function findRunnableConversation(items: ImageConversation[]) {
  return (
    items.find((conversation) => hasLoadingTurn(conversation, "generating")) ??
    items.find((conversation) => hasLoadingTurn(conversation, "queued")) ??
    null
  );
}

function getImageTaskKey(conversationId: string, turnId: string, imageId: string) {
  return `${conversationId}:${turnId}:${imageId}`;
}

function getImageTaskStats(items: ImageConversation[]) {
  let queued = 0;
  let running = 0;

  for (const conversation of items) {
    for (const turn of conversation.turns) {
      if (turn.status !== "queued" && turn.status !== "generating") {
        continue;
      }
      for (const image of turn.images) {
        if (image.status !== "loading") {
          continue;
        }
        if (turn.status === "generating" || activeImageTaskIds.has(getImageTaskKey(conversation.id, turn.id, image.id))) {
          running += 1;
        } else {
          queued += 1;
        }
      }
    }
  }

  return { queued, running };
}

function getWaitingImageTaskCount(items: ImageConversation[]) {
  let waiting = 0;

  for (const conversation of items) {
    for (const turn of conversation.turns) {
      if (turn.status !== "queued") {
        continue;
      }
      for (const image of turn.images) {
        if (image.status === "loading" && !activeImageTaskIds.has(getImageTaskKey(conversation.id, turn.id, image.id))) {
          waiting += 1;
        }
      }
    }
  }

  return waiting;
}

function deriveTurnStatus(turn: ImageTurn): Pick<ImageTurn, "status" | "error"> {
  const loadingCount = turn.images.filter((image) => image.status === "loading").length;
  const failedCount = turn.images.filter((image) => image.status === "error").length;
  const successCount = turn.images.filter((image) => image.status === "success").length;
  if (loadingCount > 0) {
    return { status: turn.status === "queued" ? "queued" : "generating", error: undefined };
  }
  if (failedCount > 0) {
    return { status: "error", error: `其中 ${failedCount} 张未成功生成` };
  }
  if (successCount > 0) {
    return { status: "success", error: undefined };
  }
  return { status: "queued", error: undefined };
}

async function syncConversationImageTasks(items: ImageConversation[]) {
  const taskIds = Array.from(
    new Set(
      items.flatMap((conversation) =>
        conversation.turns.flatMap((turn) =>
          turn.images.flatMap((image) =>
            image.status !== "success" && image.taskId ? [image.taskId] : [],
          ),
        ),
      ),
    ),
  );
  if (taskIds.length === 0) {
    return items;
  }

  let taskList: Awaited<ReturnType<typeof fetchImageTasks>>;
  try {
    taskList = await fetchImageTasks(taskIds);
  } catch {
    return items;
  }
  const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status === "success" || !image.taskId) {
          return image;
        }
        const task = taskMap.get(image.taskId);
        if (!task) {
          return image;
        }
        const nextImage = taskDataToStoredImage(image, task);
        if (nextImage !== image) {
          turnChanged = true;
        }
        return nextImage;
      });
      if (!turnChanged) {
        return turn;
      }
      changed = true;
      const derived = deriveTurnStatus({ ...turn, images });
      return {
        ...turn,
        ...derived,
        images,
      };
    });
    if (turns === conversation.turns || !turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }
    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }
  return normalized;
}

async function recoverConversationHistory(items: ImageConversation[]) {
  let changed = false;
  const normalized = items.map((conversation) => {
    const turns = conversation.turns.map((turn) => {
      if (turn.status !== "queued" && turn.status !== "generating") {
        return turn;
      }

      let turnChanged = false;
      const images = turn.images.map((image) => {
        if (image.status !== "loading" || image.taskId) {
          return image;
        }
        turnChanged = true;
        return {
          ...image,
          status: "error" as const,
          error: "页面刷新或任务中断，未找到可恢复的任务 ID",
        };
      });
      const derived = deriveTurnStatus({ ...turn, images });
      if (!turnChanged && derived.status === turn.status && derived.error === turn.error) {
        return turn;
      }
      changed = true;
      return {
        ...turn,
        ...derived,
        images,
      };
    });

    if (!turns.some((turn, index) => turn !== conversation.turns[index])) {
      return conversation;
    }

    return {
      ...conversation,
      turns,
      updatedAt: new Date().toISOString(),
    };
  });

  if (changed) {
    await saveImageConversations(normalized);
  }

  return syncConversationImageTasks(normalized);
}


function ImagePageContent() {
  const didNotifyRestoredTasksRef = useRef(false);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const pendingConversationSaveTimersRef = useRef<Map<string, number>>(new Map());
  const pendingConversationSavesRef = useRef<Map<string, ImageConversation>>(new Map());
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const redeemedShareCodeRef = useRef("");

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageSize, setImageSize] = useState(DEFAULT_IMAGE_SIZE);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const storedValue = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (storedValue === "1" || storedValue === "0") {
      return storedValue === "1";
    }
    return window.innerWidth >= 1024;
  });
  const [isTopInfoCollapsed, setIsTopInfoCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const storedValue = window.localStorage.getItem(TOP_INFO_COLLAPSED_STORAGE_KEY);
    if (storedValue === "1" || storedValue === "0") {
      return storedValue === "1";
    }
    return window.innerWidth >= 640;
  });
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);
  const [ipQuota, setIpQuota] = useState<IpQuotaResponse | null>(null);
  const [isPolishingPrompt, setIsPolishingPrompt] = useState(false);
  const [mobileShellHeight, setMobileShellHeight] = useState<number | null>(null);
  const mobileShellHeightRef = useRef<number | null>(null);

  const parsedCount = useMemo(() => Number(clampImageCount(imageCount)), [imageCount]);
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const deferredSelectedConversation = useDeferredValue(selectedConversation);
  const currentImageModeLabel = referenceImages.length > 0 ? "图片编辑" : "文生图";
  const taskStats = useMemo(
    () => getImageTaskStats(conversations),
    [conversations],
  );
  const scrollResultsToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = resultsViewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
  }, []);
  const scheduleScrollResultsToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const timers: number[] = [];
      let animationFrame = 0;

      scrollResultsToBottom(behavior);
      animationFrame = window.requestAnimationFrame(() => scrollResultsToBottom("auto"));
      [80, 220, 520, 1000].forEach((delay) => {
        timers.push(window.setTimeout(() => scrollResultsToBottom("auto"), delay));
      });

      return () => {
        if (animationFrame) {
          window.cancelAnimationFrame(animationFrame);
        }
        timers.forEach((timer) => window.clearTimeout(timer));
      };
    },
    [scrollResultsToBottom],
  );
  const deleteConfirmTitle = deleteConfirm?.type === "all" ? "清空历史记录" : deleteConfirm?.type === "one" ? "删除对话" : "";
  const deleteConfirmDescription =
    deleteConfirm?.type === "all"
      ? "确认删除全部图片历史记录吗？删除后无法恢复。"
      : deleteConfirm?.type === "one"
        ? "确认删除这条图片对话吗？删除后无法恢复。"
        : "";

  const loadIpQuota = useCallback(async () => {
    try {
      setIpQuota(await fetchIpQuota());
    } catch {
      setIpQuota(null);
    }
  }, []);

  useEffect(() => {
    void loadIpQuota();
  }, [loadIpQuota]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const shareCode = new URLSearchParams(window.location.search).get("share")?.trim() || "";
    if (!shareCode || redeemedShareCodeRef.current === shareCode) {
      return;
    }
    redeemedShareCodeRef.current = shareCode;
    void redeemImageShareLink(shareCode)
      .then((result) => {
        if (result.awarded) {
          toast.success(result.message || "已领取分享奖励");
        } else {
          toast.info(result.message || "分享奖励无需重复领取");
        }
        if (result.ip_quota) {
          setIpQuota(result.ip_quota);
        } else {
          void loadIpQuota();
        }
      })
      .catch((error) => {
        toast.error(getErrorMessage(error, "领取分享奖励失败"));
      })
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("share");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      });
  }, [loadIpQuota]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    const pendingTimers = pendingConversationSaveTimersRef.current;
    const pendingSaves = pendingConversationSavesRef.current;
    return () => {
      pendingTimers.forEach((timer) => window.clearTimeout(timer));
      pendingTimers.clear();
      pendingSaves.forEach((conversation) => {
        void saveImageConversation(conversation);
      });
      pendingSaves.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    const body = document.body;
    const virtualKeyboard = (
      navigator as Navigator & {
        virtualKeyboard?: { overlaysContent: boolean };
      }
    ).virtualKeyboard;
    let baselineHeight = 0;
    let keyboardFrame = 0;
    let lastKeyboardOffset = -1;

    const isMobile = () => window.innerWidth < 640;
    const isTextInputFocused = () => {
      const active = document.activeElement;
      return (
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      );
    };

    const lockMobilePage = () => {
      if (!isMobile()) {
        root.classList.remove("image-mobile-lock", "image-keyboard-active");
        body.classList.remove("image-mobile-lock");
        root.style.removeProperty("--image-composer-keyboard-offset");
        mobileShellHeightRef.current = null;
        setMobileShellHeight(null);
        return;
      }

      root.classList.add("image-mobile-lock");
      body.classList.add("image-mobile-lock");
      if (!isTextInputFocused()) {
        const visibleHeight = Math.max(
          window.innerHeight,
          (window.visualViewport?.height || 0) + (window.visualViewport?.offsetTop || 0),
        );
        baselineHeight = Math.max(visibleHeight, baselineHeight);
        const nextShellHeight = Math.max(360, Math.round(visibleHeight - MOBILE_SHELL_TOP_HEIGHT));
        if (mobileShellHeightRef.current !== nextShellHeight) {
          mobileShellHeightRef.current = nextShellHeight;
          setMobileShellHeight(nextShellHeight);
        }
        root.classList.remove("image-keyboard-active");
        lastKeyboardOffset = 0;
        root.style.setProperty("--image-composer-keyboard-offset", "0px");
        return;
      }

      const viewport = window.visualViewport;
      const viewportHeight = viewport?.height || window.innerHeight;
      const viewportOffsetTop = viewport?.offsetTop || 0;
      const keyboardOffset = Math.max(0, baselineHeight - viewportHeight - viewportOffsetTop);
      root.classList.add("image-keyboard-active");
      const roundedOffset = Math.round(keyboardOffset);
      if (Math.abs(roundedOffset - lastKeyboardOffset) < 2) {
        return;
      }
      lastKeyboardOffset = roundedOffset;
      if (keyboardFrame) {
        window.cancelAnimationFrame(keyboardFrame);
      }
      keyboardFrame = window.requestAnimationFrame(() => {
        root.style.setProperty("--image-composer-keyboard-offset", `${roundedOffset}px`);
        keyboardFrame = 0;
      });
    };

    try {
      if (virtualKeyboard) {
        virtualKeyboard.overlaysContent = true;
      }
    } catch {
      // Some embedded browsers expose the object but reject the assignment.
    }

    lockMobilePage();
    const handleFocusIn = () => {
      window.setTimeout(lockMobilePage, 0);
      [120, 320].forEach((delay) => window.setTimeout(lockMobilePage, delay));
    };
    const handleFocusOut = () => {
      window.setTimeout(lockMobilePage, 80);
    };

    window.addEventListener("resize", lockMobilePage);
    window.addEventListener("orientationchange", lockMobilePage);
    window.addEventListener("pageshow", lockMobilePage);
    window.addEventListener("focus", lockMobilePage);
    window.visualViewport?.addEventListener("resize", lockMobilePage);
    document.addEventListener("visibilitychange", lockMobilePage);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    return () => {
      root.classList.remove("image-mobile-lock", "image-keyboard-active");
      body.classList.remove("image-mobile-lock");
      root.style.removeProperty("--image-composer-keyboard-offset");
      if (keyboardFrame) {
        window.cancelAnimationFrame(keyboardFrame);
      }
      window.removeEventListener("resize", lockMobilePage);
      window.removeEventListener("orientationchange", lockMobilePage);
      window.removeEventListener("pageshow", lockMobilePage);
      window.removeEventListener("focus", lockMobilePage);
      window.visualViewport?.removeEventListener("resize", lockMobilePage);
      document.removeEventListener("visibilitychange", lockMobilePage);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, isSidebarCollapsed ? "1" : "0");
  }, [isSidebarCollapsed]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(TOP_INFO_COLLAPSED_STORAGE_KEY, isTopInfoCollapsed ? "1" : "0");
  }, [isTopInfoCollapsed]);

  useEffect(() => {
    let cancelled = false;

    const applyLoadedConversations = (items: ImageConversation[]) => {
      conversationsRef.current = items;
      setConversations(items);
      const storedConversationId =
        typeof window !== "undefined"
          ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) ||
            window.localStorage.getItem(LEGACY_ACTIVE_CONVERSATION_STORAGE_KEY)
          : null;
      const nextSelectedConversationId =
        (storedConversationId && items.some((conversation) => conversation.id === storedConversationId)
          ? storedConversationId
          : null) ?? pickFallbackConversationId(items);
      setSelectedConversationId(nextSelectedConversationId);
    };

    const loadHistory = async () => {
      try {
        const storedSize =
          typeof window !== "undefined"
            ? window.localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) ||
              window.localStorage.getItem(LEGACY_IMAGE_SIZE_STORAGE_KEY)
            : null;
        setImageSize(storedSize || DEFAULT_IMAGE_SIZE);
        setImageCount("1");

        const items = await listImageConversations();
        if (cancelled) {
          return;
        }

        applyLoadedConversations(items);
        setIsLoadingHistory(false);
        runWhenIdle(() => {
          void (async () => {
            const normalizedItems = await recoverConversationHistory(items);
            if (cancelled) {
              return;
            }
            applyLoadedConversations(normalizedItems);
            if (
              !didNotifyRestoredTasksRef.current &&
              normalizedItems.some((conversation) =>
                conversation.turns.some(
                  (turn) =>
                    (turn.status === "queued" || turn.status === "generating") &&
                    turn.images.some((image) => image.status === "loading" && image.taskId),
                ),
              )
            ) {
              didNotifyRestoredTasksRef.current = true;
              toast.info("\u68c0\u6d4b\u5230\u672a\u5b8c\u6210\u4efb\u52a1\uff0c\u5df2\u7ee7\u7eed\u540c\u6b65\u7ed3\u679c\uff1b\u5237\u65b0\u9875\u9762\u4e0d\u4f1a\u4e2d\u65ad\u540e\u53f0\u751f\u6210\u3002");
            }
          })();
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "\u8bfb\u53d6\u4f1a\u8bdd\u8bb0\u5f55\u5931\u8d25";
        toast.error(message);
      } finally {
        if (!cancelled) {
          setIsLoadingHistory(false);
        }
      }
    };

    void loadHistory();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedConversationTurnCount = selectedConversation?.turns.length ?? 0;

  useEffect(() => {
    if (!selectedConversationId || selectedConversationTurnCount === 0) {
      return;
    }

    const behavior: ScrollBehavior = isLoadingHistory ? "auto" : "smooth";
    return scheduleScrollResultsToBottom(behavior);
  }, [
    isLoadingHistory,
    scheduleScrollResultsToBottom,
    selectedConversationId,
    selectedConversationTurnCount,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cleanupScroll: (() => void) | undefined;
    const restoreBottomPosition = () => {
      if (!selectedConversationId) {
        return;
      }
      cleanupScroll?.();
      cleanupScroll = scheduleScrollResultsToBottom("auto");
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        restoreBottomPosition();
      }
    };

    window.addEventListener("pageshow", restoreBottomPosition);
    window.addEventListener("focus", restoreBottomPosition);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cleanupScroll?.();
      window.removeEventListener("pageshow", restoreBottomPosition);
      window.removeEventListener("focus", restoreBottomPosition);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [scheduleScrollResultsToBottom, selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedConversationId) {
      window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, selectedConversationId);
    } else {
      window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    }
  }, [selectedConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (imageSize) {
      window.localStorage.setItem(IMAGE_SIZE_STORAGE_KEY, imageSize);
      return;
    }
    window.localStorage.removeItem(IMAGE_SIZE_STORAGE_KEY);
  }, [imageSize]);

  useEffect(() => {
    if (selectedConversationId && !conversations.some((conversation) => conversation.id === selectedConversationId)) {
      setSelectedConversationId(pickFallbackConversationId(conversations));
    }
  }, [conversations, selectedConversationId]);

  const persistConversation = async (conversation: ImageConversation) => {
    const nextConversations = sortImageConversations([
      conversation,
      ...conversationsRef.current.filter((item) => item.id !== conversation.id),
    ]);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    await saveImageConversation(conversation);
  };

  const scheduleSaveConversation = useCallback((conversation: ImageConversation) => {
    const pendingTimers = pendingConversationSaveTimersRef.current;
    const pendingSaves = pendingConversationSavesRef.current;
    const previousTimer = pendingTimers.get(conversation.id);
    if (previousTimer) {
      window.clearTimeout(previousTimer);
    }
    pendingSaves.set(conversation.id, conversation);
    const timer = window.setTimeout(() => {
      pendingTimers.delete(conversation.id);
      const latestConversation = pendingSaves.get(conversation.id) ?? conversation;
      pendingSaves.delete(conversation.id);
      void saveImageConversation(latestConversation);
    }, 500);
    pendingTimers.set(conversation.id, timer);
  }, []);

  const updateConversation = useCallback(
    async (
      conversationId: string,
      updater: (current: ImageConversation | null) => ImageConversation,
      options: { persist?: boolean } = {},
    ) => {
      const current = conversationsRef.current.find((item) => item.id === conversationId) ?? null;
      const nextConversation = updater(current);
      const nextConversations = sortImageConversations([
        nextConversation,
        ...conversationsRef.current.filter((item) => item.id !== conversationId),
      ]);
      conversationsRef.current = nextConversations;
      startTransition(() => {
        setConversations(nextConversations);
      });
      if (options.persist !== false) {
        scheduleSaveConversation(nextConversation);
      }
    },
    [scheduleSaveConversation],
  );

  const clearComposerInputs = useCallback(() => {
    setImagePrompt("");
    setReferenceImageFiles([]);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const resetComposer = useCallback(() => {
    clearComposerInputs();
  }, [clearComposerInputs]);

  const handleCreateDraft = () => {
    setSelectedConversationId(null);
    resetComposer();
    textareaRef.current?.focus();
  };

  const handleDeleteConversation = async (id: string) => {
    const nextConversations = conversations.filter((item) => item.id !== id);
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    if (selectedConversationId === id) {
      setSelectedConversationId(pickFallbackConversationId(nextConversations));
      resetComposer();
    }

    try {
      await deleteImageConversation(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除会话失败";
      toast.error(message);
      const items = await listImageConversations();
      conversationsRef.current = items;
      setConversations(items);
    }
  };

  const handleDeleteFailedImage = useCallback(
    async (conversationId: string, turnId: string, imageId: string) => {
      const currentConversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!currentConversation) {
        return;
      }

      const turns = currentConversation.turns
        .map((turn) => {
          if (turn.id !== turnId) {
            return turn;
          }
          const images = turn.images.filter((image) => image.id !== imageId || image.status !== "error");
          const derived = images.length > 0 ? deriveTurnStatus({ ...turn, images }) : { status: "error" as const, error: undefined };
          return {
            ...turn,
            ...derived,
            images,
            count: images.length,
          };
        })
        .filter((turn) => turn.images.length > 0);

      if (turns.length === 0) {
        const nextConversations = conversationsRef.current.filter((item) => item.id !== conversationId);
        conversationsRef.current = nextConversations;
        setConversations(nextConversations);
        if (selectedConversationId === conversationId) {
          setSelectedConversationId(pickFallbackConversationId(nextConversations));
          resetComposer();
        }
        await deleteImageConversation(conversationId);
        toast.success("已删除失败记录");
        return;
      }

      await persistConversation({
        ...currentConversation,
        updatedAt: new Date().toISOString(),
        turns,
      });
      toast.success("已删除失败记录");
    },
    [resetComposer, selectedConversationId],
  );

  const handleClearHistory = async () => {
    try {
      await clearImageConversations();
      conversationsRef.current = [];
      setConversations([]);
      setSelectedConversationId(null);
      resetComposer();
      toast.success("已清空历史记录");
    } catch (error) {
      const message = error instanceof Error ? error.message : "清空历史记录失败";
      toast.error(message);
    }
  };

  const openDeleteConversationConfirm = (id: string) => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "one", id });
  };

  const openClearHistoryConfirm = () => {
    setIsHistoryOpen(false);
    setDeleteConfirm({ type: "all" });
  };

  const handleConfirmDelete = async () => {
    const target = deleteConfirm;
    setDeleteConfirm(null);
    if (!target) {
      return;
    }
    if (target.type === "all") {
      await handleClearHistory();
      return;
    }
    await handleDeleteConversation(target.id);
  };

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    try {
      const previews = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "image/png",
          dataUrl: await readFileAsDataUrl(file),
        })),
      );

      setReferenceImageFiles((prev) => [...prev, ...files]);
      setReferenceImages((prev) => [...prev, ...previews]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取参考图失败";
      toast.error(message);
    }
  }, []);

  const handleReferenceImageChange = useCallback(
    async (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      await appendReferenceImages(files);
    },
    [appendReferenceImages],
  );

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImageFiles((prev) => {
      const next = prev.filter((_, currentIndex) => currentIndex !== index);
      if (next.length === 0 && fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return next;
    });
    setReferenceImages((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const handleClearReferenceImages = useCallback(() => {
    setReferenceImageFiles([]);
    setReferenceImages([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("image-mode-changed", {
        detail: referenceImages.length > 0 ? "edit" : "generate",
      }),
    );
  }, [referenceImages.length]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleModeRequest = (event: Event) => {
      const mode = (event as CustomEvent<"generate" | "edit">).detail;
      if (mode === "generate") {
        handleClearReferenceImages();
        textareaRef.current?.focus();
        return;
      }
      if (mode === "edit") {
        fileInputRef.current?.click();
      }
    };

    window.addEventListener("image-mode-request", handleModeRequest);
    return () => {
      window.removeEventListener("image-mode-request", handleModeRequest);
    };
  }, [handleClearReferenceImages]);

  const handleContinueEdit = useCallback(
    async (conversationId: string, image: StoredImage | StoredReferenceImage) => {
      try {
        const nextReference =
          "dataUrl" in image
            ? {
                referenceImage: image,
                file: dataUrlToFile(image.dataUrl, image.name, image.type),
              }
            : await buildReferenceImageFromStoredImage(image, `conversation-${conversationId}-${Date.now()}.png`);
        if (!nextReference) {
          return;
        }

        setSelectedConversationId(conversationId);

        setReferenceImages((prev) => [...prev, nextReference.referenceImage]);
        setReferenceImageFiles((prev) => [...prev, nextReference.file]);
        setImagePrompt("");
        textareaRef.current?.focus();
        toast.success("已加入当前参考图，继续输入描述即可编辑");
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取结果图失败";
        toast.error(message);
      }
    },
    [],
  );

  const openLightbox = useCallback((images: ImageLightboxItem[], index: number) => {
    if (images.length === 0) {
      return;
    }

    setLightboxImages(images);
    setLightboxIndex(Math.max(0, Math.min(index, images.length - 1)));
    setLightboxOpen(true);
  }, []);

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const runConversationQueue = useCallback(
    async (conversationId: string) => {
      const availableSlots = getMaxConcurrentImageTasks() - activeImageTaskIds.size;
      if (availableSlots <= 0) {
        return;
      }

      const snapshot = conversationsRef.current.find((conversation) => conversation.id === conversationId);
      const activeTurn = snapshot?.turns.find(
        (turn) =>
          (turn.status === "queued" || turn.status === "generating") &&
          turn.images.some((image) => image.status === "loading"),
      );
      if (!snapshot || !activeTurn) {
        return;
      }

      const pendingImages = activeTurn.images
        .filter(
          (image) =>
            image.status === "loading" &&
            !activeImageTaskIds.has(getImageTaskKey(conversationId, activeTurn.id, image.id)),
        )
        .slice(0, availableSlots);
      if (pendingImages.length === 0) {
        return;
      }

      const activeTaskKeys = pendingImages.map((image) => getImageTaskKey(conversationId, activeTurn.id, image.id));
      activeTaskKeys.forEach((key) => activeImageTaskIds.add(key));
      try {
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "generating",
                    error: undefined,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, taskId: image.taskId || image.id } : image,
                    ),
                  }
                : turn,
            ),
          };
        });

        const updateGeneratedImage = async (generatedImage: StoredImage) => {
          await updateConversation(conversationId, (current) => {
            const conversation = current ?? snapshot;
            const turns = conversation.turns.map((turn) => {
              if (turn.id !== activeTurn.id) {
                return turn;
              }
              const images = turn.images.map((image) => (image.id === generatedImage.id ? generatedImage : image));
              const derived = deriveTurnStatus({ ...turn, status: "generating", images });
              return {
                ...turn,
                ...derived,
                images,
              };
            });
            return {
              ...conversation,
              updatedAt: new Date().toISOString(),
              turns,
            };
          });
        };
        const rememberReturnedTaskId = async (imageId: string, returnedTaskId: string) => {
          await updateGeneratedImage({
            id: imageId,
            taskId: returnedTaskId,
            status: "loading",
            completedAt: undefined,
          });
        };
        const generatedImages = await Promise.all(
          pendingImages.map(async (image) => {
            const taskId = image.taskId || image.id;
            let effectiveTaskId = taskId;
            try {
              const existingTaskList = image.taskId ? await fetchImageTasks([taskId]).catch(() => null) : null;
              const existingTask = existingTaskList?.items.find((item) => item.id === taskId);
              const submittedTask = await (
                existingTask ??
                (async () => {
                  if (activeTurn.mode === "edit") {
                    const editFiles = activeTurn.referenceImages.map((referenceImage, referenceIndex) =>
                      dataUrlToFile(
                        referenceImage.dataUrl,
                        referenceImage.name || `reference-${referenceIndex + 1}.png`,
                        referenceImage.type,
                      ),
                    );
                    if (editFiles.length === 0) {
                      throw new Error("缂栬緫浠诲姟缂哄皯鍙傝€冨浘锛岃閲嶆柊涓婁紶鍥剧墖");
                    }
                    return createImageEditTask(taskId, editFiles, activeTurn.prompt, activeTurn.model, activeTurn.size);
                  }
                  return createImageGenerationTask(taskId, activeTurn.prompt, activeTurn.model, activeTurn.size);
                })()
              );
              const returnedTaskId = submittedTask.id || taskId;
              effectiveTaskId = returnedTaskId;
              if (returnedTaskId !== image.taskId) {
                await rememberReturnedTaskId(image.id, returnedTaskId);
              }
              const task =
                submittedTask.status === "success" || submittedTask.status === "error"
                  ? submittedTask
                  : await waitForImageTask(returnedTaskId);
              if (!task) {
                return {
                  ...image,
                  taskId: returnedTaskId,
                  status: "loading" as const,
                  error: undefined,
                  completedAt: undefined,
                };
              }
              if (task.status === "error") {
                throw new Error(task.error || "生成图片失败");
              }
              const response: ImageResponse = {
                created: Date.now(),
                data: task.data || [],
              };
              let first: ImageResponse["data"][number] | undefined;
              try {
                first = response.data?.[0] ? await recallImageResult(response.data[0]) : undefined;
                if (!first?.b64_json && !first?.url) {
                  throw new Error("接口没有返回图片数据");
                }
              } catch (error) {
                await refundIpQuota(1).catch(() => null);
                throw error;
              }
              const generatedImage = {
                ...image,
                taskId: returnedTaskId,
                status: "success" as const,
                b64_json: first.b64_json,
                url: undefined,
                revised_prompt: first.revised_prompt,
                error: undefined,
                completedAt: new Date().toISOString(),
              };
              await updateGeneratedImage(generatedImage);
              return generatedImage;
            } catch (error) {
              const recoveredTaskList = effectiveTaskId
                ? await fetchImageTasks([effectiveTaskId]).catch(() => null)
                : null;
              const recoveredTask = recoveredTaskList?.items.find((item) => item.id === effectiveTaskId);
              if (recoveredTask?.status === "success") {
                const recoveredResponse: ImageResponse = {
                  created: Date.now(),
                  data: recoveredTask.data || [],
                };
                let recoveredImage: ImageResponse["data"][number] | undefined;
                try {
                  recoveredImage = recoveredResponse.data?.[0]
                    ? await recallImageResult(recoveredResponse.data[0])
                    : undefined;
                  if (!recoveredImage?.b64_json && !recoveredImage?.url) {
                    throw new Error("接口没有返回图片数据");
                  }
                } catch (recallError) {
                  await refundIpQuota(1).catch(() => null);
                  throw recallError;
                }
                const generatedImage = {
                  ...image,
                  taskId: effectiveTaskId,
                  status: "success" as const,
                  b64_json: recoveredImage.b64_json,
                  url: undefined,
                  revised_prompt: recoveredImage.revised_prompt,
                  error: undefined,
                  completedAt: new Date().toISOString(),
                };
                await updateGeneratedImage(generatedImage);
                return generatedImage;
              }
              if (recoveredTask?.status === "queued" || recoveredTask?.status === "running") {
                const pendingImage = {
                  ...image,
                  taskId: effectiveTaskId,
                  status: "loading" as const,
                  error: undefined,
                  completedAt: undefined,
                };
                await updateGeneratedImage(pendingImage);
                return pendingImage;
              }
              const message = error instanceof Error ? error.message : "生成图片失败";
              if (image.taskId && isRecoverableTaskSyncError(error)) {
                const pendingImage = {
                  ...image,
                  taskId: effectiveTaskId,
                  status: "loading" as const,
                  error: undefined,
                  completedAt: undefined,
                };
                await updateGeneratedImage(pendingImage);
                return pendingImage;
              }
              const generatedImage = {
                ...image,
                taskId: effectiveTaskId,
                status: "error" as const,
                error: message,
                completedAt: new Date().toISOString(),
              };
              await updateGeneratedImage(generatedImage);
              return generatedImage;
            }
          }),
        );

        const failedCount = generatedImages.filter((image) => image.status === "error").length;
        if (failedCount > 0) {
          if (failedCount === generatedImages.length) {
            toast.error(generatedImages[0]?.error || "生成图片失败");
          } else {
            toast.error(`有 ${failedCount} 张图片生成失败`);
          }
        }

        await loadIpQuota();
      } catch (error) {
        const message = error instanceof Error ? error.message : "生成图片失败";
        await updateConversation(conversationId, (current) => {
          const conversation = current ?? snapshot;
          return {
            ...conversation,
            updatedAt: new Date().toISOString(),
            turns: conversation.turns.map((turn) =>
              turn.id === activeTurn.id
                ? {
                    ...turn,
                    status: "error",
                    error: message,
                    images: turn.images.map((image) =>
                      image.status === "loading" ? { ...image, status: "error", error: message } : image,
                    ),
                  }
                : turn,
            ),
          };
        });
        toast.error(message);
      } finally {
        activeTaskKeys.forEach((key) => activeImageTaskIds.delete(key));
        if (activeImageTaskIds.size < getMaxConcurrentImageTasks()) {
          const nextConversation = findRunnableConversation(conversationsRef.current);
          if (nextConversation) {
            runWhenIdle(() => {
              void runConversationQueue(nextConversation.id);
            });
          }
        }
      }
    },
    [loadIpQuota, updateConversation],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const createSubmittedImageTasks = useCallback(
    async (
      conversationId: string,
      turnId: string,
      turn: ImageTurn,
      editFiles: File[],
    ) => {
      const createdImages = await Promise.allSettled(
        turn.images.map(async (image) => {
          const taskId = image.taskId || image.id;
          const task =
            turn.mode === "edit"
              ? await createImageEditTask(taskId, editFiles, turn.prompt, turn.model, turn.size)
              : await createImageGenerationTask(taskId, turn.prompt, turn.model, turn.size);
          return {
            imageId: image.id,
            taskId: task.id || taskId,
          };
        }),
      );
      const createdTaskMap = new Map(
        createdImages.flatMap((item) => (item.status === "fulfilled" ? [[item.value.imageId, item.value.taskId]] : [])),
      );
      const failedMessages = createdImages.flatMap((item) =>
        item.status === "rejected" ? [getErrorMessage(item.reason, "创建图片任务失败")] : [],
      );
      await updateConversation(conversationId, (current) => {
        const conversation = current ?? conversationsRef.current.find((item) => item.id === conversationId);
        if (!conversation) {
          throw new Error("未找到图片任务记录");
        }
        return {
          ...conversation,
          updatedAt: new Date().toISOString(),
          turns: conversation.turns.map((item) =>
            item.id === turnId
              ? {
                  ...item,
                  status: createdTaskMap.size > 0 ? "generating" : "error",
                  error: createdTaskMap.size > 0 ? undefined : failedMessages[0],
                  images: item.images.map((image) => {
                    const createdTaskId = createdTaskMap.get(image.id);
                    return createdTaskId
                        ? {
                            ...image,
                            taskId: createdTaskId,
                            status: "loading",
                            error: undefined,
                            completedAt: undefined,
                          }
                        : {
                            ...image,
                            status: "error",
                            error: failedMessages[0] || "创建图片任务失败",
                            completedAt: new Date().toISOString(),
                          };
                  }),
                }
              : item,
          ),
        };
      });
      await loadIpQuota();
      if (failedMessages.length > 0) {
        toast.error(failedMessages[0]);
      }
      return createdTaskMap.size;
    },
    [loadIpQuota, updateConversation],
  );

  useEffect(() => {
    if (activeImageTaskIds.size >= getMaxConcurrentImageTasks()) {
      return;
    }
    const nextConversation = findRunnableConversation(conversations);
    if (!nextConversation) {
      return;
    }
    runWhenIdle(() => {
      void runConversationQueue(nextConversation.id);
    });
  }, [conversations, runConversationQueue]);

  const handleSubmit = async () => {
    const prompt = imagePrompt.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }

    if (ipQuota && ipQuota.limit >= 0 && parsedCount > ipQuota.remaining) {
      toast.error(`当前${formatIpQuotaType(ipQuota)}剩余额度不足，还剩 ${ipQuota.remaining} 张`);
      return;
    }
    const waitingTaskCount = getWaitingImageTaskCount(conversationsRef.current);
    if (waitingTaskCount + parsedCount > MAX_QUEUED_IMAGE_TASKS) {
      toast.error(`当前最多只能排队 ${MAX_QUEUED_IMAGE_TASKS} 张图片，请等待前面的任务处理`);
      return;
    }

    const effectiveImageMode: ImageConversationMode = referenceImages.length > 0 ? "edit" : "generate";
    const submittedReferenceImageFiles = referenceImageFiles;

    const targetConversation = selectedConversationId
      ? conversationsRef.current.find((conversation) => conversation.id === selectedConversationId) ?? null
      : null;
    const now = new Date().toISOString();
    const conversationId = targetConversation?.id ?? createId();
    const turnId = createId();
    const draftTurn: ImageTurn = {
      id: turnId,
      prompt,
      model: "gpt-image-2",
      mode: effectiveImageMode,
      referenceImages: referenceImages.map((image) => ({ ...image })),
      count: parsedCount,
      size: imageSize,
      images: Array.from({ length: parsedCount }, (_, index) => {
        const imageId = `${turnId}-${index}`;
        return {
          id: imageId,
          taskId: imageId,
          status: "loading" as const,
        };
      }),
      createdAt: now,
      status: "queued",
    };

    const baseConversation: ImageConversation = targetConversation
      ? {
          ...targetConversation,
          updatedAt: now,
          turns: [...targetConversation.turns, draftTurn],
        }
      : {
          id: conversationId,
          title: buildConversationTitle(prompt),
          createdAt: now,
          updatedAt: now,
          turns: [draftTurn],
        };

    setSelectedConversationId(conversationId);
    clearComposerInputs();

    await persistConversation(baseConversation);
    const createdTaskCount = await createSubmittedImageTasks(
      conversationId,
      turnId,
      draftTurn,
      submittedReferenceImageFiles,
    );
    if (createdTaskCount === 0) {
      await loadIpQuota();
      return;
    }
    runWhenIdle(() => {
      void runConversationQueue(conversationId);
    });

    const targetStats = getImageTaskStats([baseConversation]);
    if (targetStats.running > 0 || targetStats.queued > 1) {
      toast.success("已加入后台队列，刷新页面不会中断任务");
    } else if (!targetConversation) {
      toast.success("已提交后台处理，刷新页面不会中断任务");
    } else {
      toast.success("已发送到当前对话，后台会继续生成");
    }
  };

  const handlePolishPrompt = useCallback(async () => {
    const prompt = imagePrompt.trim();
    if (!prompt || isPolishingPrompt) {
      return;
    }
    setIsPolishingPrompt(true);
    try {
      const mode: ImageConversationMode = referenceImages.length > 0 ? "edit" : "generate";
      const result = await polishImagePrompt(prompt, mode);
      const nextPrompt = result.text.trim();
      if (!nextPrompt) {
        throw new Error("AI没有返回润色结果");
      }
      setImagePrompt(nextPrompt);
      toast.success("AI已润色提示词");
      window.setTimeout(() => {
        textareaRef.current?.focus({ preventScroll: true });
      }, 0);
    } catch (error) {
      toast.error(getErrorMessage(error, "AI润色失败"));
    } finally {
      setIsPolishingPrompt(false);
    }
  }, [imagePrompt, isPolishingPrompt, referenceImages.length]);

  return (
    <>
      <section
        style={mobileShellHeight ? { height: `${mobileShellHeight}px` } : undefined}
        className={cn(
          "fixed inset-x-0 top-12 z-10 grid min-h-0 w-full grid-cols-1 overflow-hidden px-0 pb-0 transition-[grid-template-columns] duration-300 sm:relative sm:inset-auto sm:z-auto sm:mx-auto sm:h-[calc(100dvh-5rem)] sm:max-w-[1380px] sm:translate-x-0 sm:gap-3 sm:px-3 sm:pb-6 lg:h-[calc(100dvh-5.75rem)] lg:rounded-[28px] lg:border lg:border-white/70 lg:bg-white/30 lg:p-3 lg:shadow-[0_28px_90px_-52px_rgba(68,64,60,0.55)] lg:backdrop-blur",
          !mobileShellHeight && "bottom-0",
          isSidebarCollapsed ? "lg:grid-cols-[56px_minmax(0,1fr)]" : "lg:grid-cols-[256px_minmax(0,1fr)]",
        )}
      >
        <div className="hidden h-full min-h-0 lg:block">
          {isSidebarCollapsed ? (
            <div className="flex h-full min-h-0 flex-col items-center gap-2 rounded-2xl border border-stone-200/70 bg-white/70 px-2 py-3 shadow-sm">
              <div className="group relative">
                <button
                  type="button"
                  className="inline-flex size-10 items-center justify-center rounded-xl bg-stone-950 text-white transition hover:bg-stone-800"
                  onClick={() => setIsSidebarCollapsed(false)}
                  aria-label="展开历史记录"
                >
                  <PanelLeftOpen className="size-4" />
                </button>
                <span className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-stone-950 px-2 py-1 text-xs text-white opacity-0 shadow-sm transition group-hover:opacity-100">
                  展开历史记录
                </span>
              </div>
              <div className="group relative">
                <button
                  type="button"
                  className="relative inline-flex size-10 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 hover:text-stone-950"
                  onClick={() => setIsSidebarCollapsed(false)}
                  aria-label="历史记录"
                >
                  <History className="size-4" />
                  {conversations.length > 0 ? (
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-stone-950 px-1 text-[10px] leading-4 text-white">
                      {Math.min(99, conversations.length)}
                    </span>
                  ) : null}
                </button>
                <span className="pointer-events-none absolute left-full top-1/2 z-30 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-stone-950 px-2 py-1 text-xs text-white opacity-0 shadow-sm transition group-hover:opacity-100">
                  历史记录
                </span>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col rounded-[22px] border border-white/70 bg-white/65 p-2 shadow-sm">
              <div className="mb-2 flex justify-end">
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-xl text-stone-500 transition hover:bg-white hover:text-stone-950"
                  onClick={() => setIsSidebarCollapsed(true)}
                  aria-label="收起历史记录"
                  title="收起历史记录"
                >
                  <PanelLeftClose className="size-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ImageSidebar
                  conversations={conversations}
                  isLoadingHistory={isLoadingHistory}
                  selectedConversationId={selectedConversationId}
                  onCreateDraft={handleCreateDraft}
                  onClearHistory={openClearHistoryConfirm}
                  onSelectConversation={setSelectedConversationId}
                  onDeleteConversation={openDeleteConversationConfirm}
                  formatConversationTime={formatConversationTime}
                />
              </div>
            </div>
          )}
        </div>

        <Dialog open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
          <DialogContent className="flex h-[min(88dvh,760px)] w-[94vw] max-w-[460px] flex-col overflow-hidden rounded-3xl border-white/80 bg-white p-0 shadow-[0_32px_110px_-38px_rgba(15,23,42,0.45)] sm:h-[min(82dvh,760px)] sm:rounded-[36px]">
            <DialogHeader className="px-6 pt-7 pb-4 sm:px-8">
              <DialogTitle className="flex items-center gap-2 text-xl font-bold tracking-tight">
                <History className="size-5" />
                历史记录
              </DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
              <ImageSidebar
                conversations={conversations}
                isLoadingHistory={isLoadingHistory}
                selectedConversationId={selectedConversationId}
                onCreateDraft={() => {
                  handleCreateDraft();
                  setIsHistoryOpen(false);
                }}
                onClearHistory={openClearHistoryConfirm}
                onSelectConversation={(id) => {
                  setSelectedConversationId(id);
                  setIsHistoryOpen(false);
                }}
                onDeleteConversation={openDeleteConversationConfirm}
                formatConversationTime={formatConversationTime}
                hideActionButtons
              />
            </div>
          </DialogContent>
        </Dialog>

        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:gap-4 lg:grid-rows-[minmax(0,1fr)_auto] lg:rounded-[24px] lg:border lg:border-white/70 lg:bg-white/55 lg:p-3 lg:shadow-sm">
          <section className="sticky top-0 z-40 shrink-0 bg-stone-50 sm:bg-transparent lg:hidden" aria-label="页面信息">
            {isTopInfoCollapsed ? (
              <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden border-b border-stone-200/70 bg-white px-3 text-[11px] text-stone-500 sm:rounded-2xl sm:border sm:bg-white/85 sm:px-4">
                <span className="grid min-w-0 grid-cols-[auto_auto_minmax(0,34vw)] items-center gap-1.5">
                  <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-stone-100 px-2.5 font-semibold text-stone-700">
                    {currentImageModeLabel}
                  </span>
                  <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-stone-950 px-2.5 text-white">
                    <span className="font-medium">剩余额度</span>
                    <span className="font-mono">{formatIpQuota(ipQuota)}</span>
                  </span>
                  <span className="inline-flex h-7 min-w-0 items-center rounded-full bg-stone-100 px-2.5 font-medium text-stone-600">
                    <span className="truncate">{formatIpQuotaName(ipQuota)}</span>
                  </span>
                </span>
                <button
                  type="button"
                  className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-full border border-stone-200 bg-white px-0 text-[11px] font-medium text-stone-600 transition hover:bg-stone-50"
                  onClick={() => setIsTopInfoCollapsed(false)}
                  aria-label="展开顶部信息"
                  title="展开顶部信息"
                >
                  <ChevronDown className="size-3.5" />
                  展开
                </button>
              </div>
            ) : (
              <>
                <div className="grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden border-b border-stone-200/70 bg-white px-3 text-[11px] leading-5 text-stone-500 sm:rounded-2xl sm:border sm:bg-white/85 sm:px-4 sm:text-xs">
                  <div className="grid min-w-0 grid-cols-[auto_auto_minmax(0,34vw)] items-center gap-1.5 overflow-hidden">
                    <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-stone-100 px-2.5 font-semibold text-stone-700">
                      {currentImageModeLabel}
                    </span>
                    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-stone-950 px-2.5 text-white">
                      <span className="font-medium">剩余额度</span>
                      <span className="font-mono">{formatIpQuota(ipQuota)}</span>
                    </span>
                    <span className="inline-flex h-7 min-w-0 items-center rounded-full bg-stone-100 px-2.5 font-medium text-stone-600">
                      <span className="truncate">{formatIpQuotaName(ipQuota)}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-7 w-14 shrink-0 items-center justify-center gap-1 rounded-full border border-stone-200 bg-white px-0 text-[11px] font-medium text-stone-600 transition hover:bg-stone-50"
                    onClick={() => setIsTopInfoCollapsed(true)}
                    aria-label="收起顶部信息"
                    title="收起顶部信息"
                  >
                    <ChevronUp className="size-3.5" />
                    收起
                  </button>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-stone-200/70 bg-white px-3 py-2 lg:hidden">
                  <Button
                    variant="outline"
                    className="h-9 min-w-0 rounded-[14px] border-stone-200 bg-white px-3 text-stone-700 shadow-none"
                    onClick={() => setIsHistoryOpen(true)}
                  >
                    <History className="mr-2 size-4 shrink-0" />
                    <span className="truncate">历史记录 ({conversations.length})</span>
                  </Button>
                  <Button
                    className="h-9 rounded-[14px] bg-stone-950 px-3 text-white shadow-none"
                    onClick={handleCreateDraft}
                  >
                    <Plus className="size-4" />
                    新建
                  </Button>
                  <Button
                    variant="outline"
                    className="h-9 rounded-[14px] border-stone-200 bg-white px-3 text-stone-600 shadow-none"
                    onClick={openClearHistoryConfirm}
                    disabled={conversations.length === 0}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className="image-middle-region min-h-0 overflow-hidden lg:rounded-[20px] lg:border lg:border-stone-200/60 lg:bg-stone-50/45" aria-label="图片生成区域">
            <div
              ref={resultsViewportRef}
              className="hide-scrollbar h-full min-h-0 touch-pan-y overflow-y-auto overscroll-contain px-3 py-2 sm:px-4 sm:py-4 lg:px-6 lg:py-5"
            >
              <ImageResults
                selectedConversation={deferredSelectedConversation}
                onOpenLightbox={openLightbox}
                onDeleteFailedImage={handleDeleteFailedImage}
                formatConversationTime={formatConversationTime}
              />
            </div>
          </section>

          <section className="z-50 shrink-0" aria-label="输入区域">
            <ImageComposer
              prompt={imagePrompt}
              imageCount={imageCount}
              imageSize={imageSize}
              quotaLabel={formatIpQuota(ipQuota)}
              queuedTaskCount={taskStats.queued}
              runningTaskCount={taskStats.running}
              isPolishingPrompt={isPolishingPrompt}
              referenceImages={referenceImages}
              textareaRef={textareaRef}
              fileInputRef={fileInputRef}
              onPromptChange={setImagePrompt}
              onImageCountChange={(value) => setImageCount(value ? clampImageCount(value) : "")}
              onImageSizeChange={setImageSize}
              onReferenceImageChange={handleReferenceImageChange}
              onRemoveReferenceImage={handleRemoveReferenceImage}
              onPolishPrompt={handlePolishPrompt}
              onSubmit={handleSubmit}
            />
          </section>
        </div>
      </section>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />

      {deleteConfirm ? (
        <Dialog open onOpenChange={(open) => (!open ? setDeleteConfirm(null) : null)}>
          <DialogContent showCloseButton={false} className="rounded-2xl p-6">
            <DialogHeader className="gap-2">
              <DialogTitle>{deleteConfirmTitle}</DialogTitle>
              <DialogDescription className="text-sm leading-6">
                {deleteConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
                取消
              </Button>
              <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleConfirmDelete()}>
                确认删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

export default function ImagePage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <ImagePageContent />;
}
