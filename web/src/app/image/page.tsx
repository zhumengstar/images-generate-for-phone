"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, LoaderCircle, Plus, Trash2 } from "lucide-react";
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
  fetchAccounts,
  createImageEditTask,
  createImageGenerationTask,
  fetchImageTasks,
  fetchIpQuota,
  polishImagePrompt,
  refundIpQuota,
  type Account,
  type ImageResponse,
  type ImageTask,
  type IpQuotaResponse,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
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
const IMAGE_SIZE_STORAGE_KEY = "images-generate:image_last_size";
const LEGACY_IMAGE_STORAGE_PREFIX = String.fromCharCode(99, 104, 97, 116, 103, 112, 116, 50, 97, 112, 105);
const LEGACY_ACTIVE_CONVERSATION_STORAGE_KEY = `${LEGACY_IMAGE_STORAGE_PREFIX}:image_active_conversation_id`;
const LEGACY_IMAGE_SIZE_STORAGE_KEY = `${LEGACY_IMAGE_STORAGE_PREFIX}:image_last_size`;
const MAX_CONCURRENT_IMAGE_TASKS = 2;

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

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status !== "禁用");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
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
  const response = await fetch(url);
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
        if (activeImageTaskIds.has(getImageTaskKey(conversation.id, turn.id, image.id))) {
          running += 1;
        } else {
          queued += 1;
        }
      }
    }
  }

  return { queued, running };
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


function ImagePageContent({ isAdmin }: { isAdmin: boolean }) {
  const didLoadQuotaRef = useRef(false);
  const didNotifyRestoredTasksRef = useRef(false);
  const conversationsRef = useRef<ImageConversation[]>([]);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [imagePrompt, setImagePrompt] = useState("");
  const [imageCount, setImageCount] = useState("1");
  const [imageSize, setImageSize] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [referenceImageFiles, setReferenceImageFiles] = useState<File[]>([]);
  const [referenceImages, setReferenceImages] = useState<StoredReferenceImage[]>([]);
  const [conversations, setConversations] = useState<ImageConversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [availableQuota, setAvailableQuota] = useState("加载中...");
  const [lightboxImages, setLightboxImages] = useState<ImageLightboxItem[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "one"; id: string } | { type: "all" } | null>(null);
  const [ipQuota, setIpQuota] = useState<IpQuotaResponse | null>(null);
  const [isPolishingPrompt, setIsPolishingPrompt] = useState(false);

  const parsedCount = useMemo(() => Number(clampImageCount(imageCount)), [imageCount]);
  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );
  const taskStats = useMemo(
    () => getImageTaskStats(conversations),
    [conversations],
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
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    let cancelled = false;

    const loadHistory = async () => {
      try {
        const storedSize =
          typeof window !== "undefined"
            ? window.localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) ||
              window.localStorage.getItem(LEGACY_IMAGE_SIZE_STORAGE_KEY)
            : null;
        setImageSize(storedSize || "");
        setImageCount("1");

        const items = await listImageConversations();
        const normalizedItems = await recoverConversationHistory(items);
        if (cancelled) {
          return;
        }

        conversationsRef.current = normalizedItems;
        setConversations(normalizedItems);
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
          toast.info("检测到未完成任务，已继续同步结果；刷新页面不会中断后台生成。");
        }
        const storedConversationId =
          typeof window !== "undefined"
            ? window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) ||
              window.localStorage.getItem(LEGACY_ACTIVE_CONVERSATION_STORAGE_KEY)
            : null;
        const nextSelectedConversationId =
          (storedConversationId && normalizedItems.some((conversation) => conversation.id === storedConversationId)
            ? storedConversationId
            : null) ?? pickFallbackConversationId(normalizedItems);
        setSelectedConversationId(nextSelectedConversationId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取会话记录失败";
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

  const loadQuota = useCallback(async () => {
    if (!isAdmin) {
      setAvailableQuota("--");
      return;
    }
    try {
      const data = await fetchAccounts();
      setAvailableQuota(formatAvailableQuota(data.items));
    } catch {
      setAvailableQuota((prev) => (prev === "加载中..." ? "--" : prev));
    }
  }, [isAdmin]);

  useEffect(() => {
    if (didLoadQuotaRef.current) {
      return;
    }
    didLoadQuotaRef.current = true;

    const handleFocus = () => {
      void loadQuota();
    };

    void loadQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [isAdmin, loadQuota]);

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    resultsViewportRef.current?.scrollTo({
      top: resultsViewportRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [selectedConversation?.updatedAt, selectedConversation?.turns.length, selectedConversation]);

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
      setConversations(nextConversations);
      if (options.persist !== false) {
        await saveImageConversation(nextConversation);
      }
    },
    [],
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
      const availableSlots = MAX_CONCURRENT_IMAGE_TASKS - activeImageTaskIds.size;
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
                };
                await updateGeneratedImage(pendingImage);
                return pendingImage;
              }
              const generatedImage = {
                ...image,
                taskId: effectiveTaskId,
                status: "error" as const,
                error: message,
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

        await loadQuota();
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
        while (activeImageTaskIds.size < MAX_CONCURRENT_IMAGE_TASKS) {
          const nextConversation = findRunnableConversation(conversationsRef.current);
          if (!nextConversation) {
            break;
          }
          void runConversationQueue(nextConversation.id);
        }
      }
    },
    [loadIpQuota, loadQuota, updateConversation],
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

  useEffect(() => {
    while (activeImageTaskIds.size < MAX_CONCURRENT_IMAGE_TASKS) {
      const nextConversation = findRunnableConversation(conversations);
      if (!nextConversation) {
        break;
      }
      void runConversationQueue(nextConversation.id);
    }
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

    const effectiveImageMode: ImageConversationMode = referenceImages.length > 0 ? "edit" : "generate";

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
    void runConversationQueue(conversationId);

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
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    } catch (error) {
      toast.error(getErrorMessage(error, "AI润色失败"));
    } finally {
      setIsPolishingPrompt(false);
    }
  }, [imagePrompt, isPolishingPrompt, referenceImages.length]);

  return (
    <>
      <section className="fixed inset-x-0 top-12 bottom-0 z-10 grid min-h-0 w-full grid-cols-1 overflow-hidden px-0 pb-0 sm:relative sm:top-auto sm:bottom-auto sm:z-auto sm:mx-auto sm:h-[calc(100dvh-5rem)] sm:max-w-[1380px] sm:gap-3 sm:px-3 sm:pb-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="hidden h-full min-h-0 border-r border-stone-200/70 pr-3 lg:block">
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

        <div className="flex h-full min-h-0 flex-col overflow-hidden sm:gap-4">
          <div className="shrink-0 bg-stone-50 sm:bg-transparent">
            <div className="hide-scrollbar flex flex-nowrap gap-1.5 overflow-x-auto border-b border-stone-200/70 bg-white/92 px-3 py-2 text-[11px] leading-5 text-stone-500 shadow-sm sm:flex-wrap sm:overflow-visible sm:rounded-2xl sm:border sm:bg-white/85 sm:px-4 sm:text-xs">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-stone-950 px-2.5 py-1 text-white">
                <span className="font-medium">剩余额度</span>
                <span className="font-mono">{formatIpQuota(ipQuota)}</span>
              </span>
              <span className="inline-flex max-w-[72vw] shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 sm:max-w-full">
                <span className="shrink-0 font-medium text-stone-700">{formatIpQuotaType(ipQuota)}</span>
                <span className="min-w-0 truncate font-mono">{ipQuota?.name || ipQuota?.user_id || "--"}</span>
              </span>
              <span className="inline-flex max-w-[72vw] shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 sm:max-w-full">
                <span className="shrink-0 font-medium text-stone-700">公网 IP</span>
                <span className="min-w-0 truncate font-mono">{ipQuota?.ip || "读取中"}</span>
              </span>
              <span className="hidden max-w-full items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 sm:inline-flex">
                <span className="shrink-0 font-medium text-stone-700">指纹</span>
                <span className="min-w-0 truncate font-mono">{ipQuota?.fingerprint.slice(0, 12) || "--"}</span>
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 px-3 py-1 lg:hidden">
              <Button
                variant="outline"
                className="h-9 flex-1 rounded-xl border-stone-200 bg-white text-stone-700 shadow-sm"
                onClick={() => setIsHistoryOpen(true)}
              >
                <History className="mr-2 size-4" />
                历史记录 ({conversations.length})
              </Button>
              <Button
                className="h-9 rounded-xl bg-stone-950 text-white shadow-sm"
                onClick={handleCreateDraft}
              >
                <Plus className="size-4" />
                新建
              </Button>
              <Button
                variant="outline"
                className="h-9 rounded-xl border-stone-200 bg-white px-3 text-stone-600 shadow-sm"
                onClick={openClearHistoryConfirm}
                disabled={conversations.length === 0}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>

          <div
            ref={resultsViewportRef}
            className="hide-scrollbar min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 py-2 sm:px-4 sm:py-4"
          >
            <ImageResults
              selectedConversation={selectedConversation}
              onOpenLightbox={openLightbox}
              onDeleteFailedImage={handleDeleteFailedImage}
              formatConversationTime={formatConversationTime}
            />
          </div>

          <ImageComposer
            prompt={imagePrompt}
            imageCount={imageCount}
            imageSize={imageSize}
            availableQuota={formatIpQuota(ipQuota)}
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

  return <ImagePageContent isAdmin={session.role === "admin"} />;
}
