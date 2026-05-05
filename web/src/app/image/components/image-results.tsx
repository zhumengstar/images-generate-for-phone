"use client";

import { memo, useState, type CSSProperties } from "react";
import { Clock3, LoaderCircle, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurnStatus, StoredImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onDeleteFailedImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }
  return withImageCacheKey(image.url || "", image.taskId || image.id);
}

function withImageCacheKey(url: string, cacheKey: string) {
  if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
    return url;
  }

  try {
    const baseUrl = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const parsedUrl = new URL(url, baseUrl);
    parsedUrl.searchParams.set("_image", cacheKey);
    return url.startsWith("/") ? `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}` : parsedUrl.toString();
  } catch {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}_image=${encodeURIComponent(cacheKey)}`;
  }
}

function getImageAspectStyle(size: string): CSSProperties {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(size.trim());
  if (!match) {
    return { aspectRatio: "1 / 1" };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { aspectRatio: "1 / 1" };
  }
  return { aspectRatio: `${width} / ${height}` };
}

function StoredImageElement({
  image,
  fallbackSrc,
  alt,
  className,
  onLoad,
}: {
  image: StoredImage;
  fallbackSrc: string;
  alt: string;
  className?: string;
  onLoad: (width: number, height: number) => void;
}) {
  const [loadFailed, setLoadFailed] = useState(false);

  if (loadFailed) {
    return (
      <div className="flex min-h-40 w-full items-center justify-center bg-stone-100 px-4 py-8 text-center text-sm text-stone-500">
        加载失败
      </div>
    );
  }

  return (
    <img
      src={fallbackSrc}
      alt={alt}
      className={className}
      loading="lazy"
      decoding="async"
      onLoad={(event) => onLoad(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
      onError={() => setLoadFailed(true)}
    />
  );
}

function ImageResultsComponent({
  selectedConversation,
  onOpenLightbox,
  onDeleteFailedImage,
  formatConversationTime,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});
  const [expandedPromptIds, setExpandedPromptIds] = useState<Record<string, boolean>>({});

  const togglePromptExpanded = (id: string) => {
    setExpandedPromptIds((current) => ({ ...current, [id]: !current[id] }));
  };

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    setImageDimensions((current) => {
      if (current[id] === dimensions) {
        return current;
      }
      return { ...current, [id]: dimensions };
    });
  };

  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-[220px] items-center justify-center text-center sm:min-h-[420px]">
        <div className="w-full max-w-4xl px-4">
          <h1
            className="text-[24px] font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            把想法生成图片
          </h1>
          <p
            className="mx-auto mt-3 max-w-[280px] text-sm italic tracking-[0.01em] text-stone-500 sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            输入提示词生成图片，历史记录会保留在当前浏览器中。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-4 pb-1 sm:gap-8 sm:pb-0">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const hasPendingPreviousTurn = selectedConversation.turns
          .slice(0, turnIndex)
          .some((item) => item.status === "queued" || item.status === "generating");
        const successfulTurnImages = turn.images.flatMap((image) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  src,
                  sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
                  dimensions: imageDimensions[image.id],
                },
              ]
            : [];
        });

        return (
          <div key={turn.id} className="flex flex-col gap-3 sm:gap-4">
            <div className="flex justify-end">
              <div className="max-w-[94%] rounded-2xl bg-white px-3 py-2 text-[14px] leading-6 text-stone-900 shadow-sm ring-1 ring-stone-200/70 sm:max-w-[82%] sm:bg-transparent sm:px-1 sm:py-1 sm:text-[15px] sm:leading-7 sm:shadow-none sm:ring-0">
                <div className="mb-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-stone-400 sm:mb-2">
                  <span>第 {turnIndex + 1} 轮</span>
                  <span>{turn.mode === "edit" ? "图片编辑" : "图片生成"}</span>
                  <span>{getTurnStatusLabel(turn.status)}</span>
                  <span>{formatConversationTime(turn.createdAt)}</span>
                </div>
                <button
                  type="button"
                  className={cn(
                    "block w-full cursor-pointer break-words text-right sm:block",
                    !expandedPromptIds[turn.id] && "image-mobile-text-clamp-3 sm:max-h-none sm:overflow-visible",
                  )}
                  onClick={() => togglePromptExpanded(turn.id)}
                >
                  {turn.prompt}
                </button>
              </div>
            </div>

            <div className="flex justify-start">
              <div className="w-full p-0 sm:p-1">
                {turn.referenceImages.length > 0 ? (
                  <div className="mb-3 flex flex-col items-start sm:mb-4 sm:items-end">
                    <div className="mb-3 text-xs font-medium text-stone-500">本轮参考图</div>
                    <div className="flex flex-wrap justify-start gap-2 sm:justify-end sm:gap-3">
                      {turn.referenceImages.map((image, index) => (
                        <div key={`${turn.id}-${image.name}-${index}`} className="flex flex-col items-end gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              onOpenLightbox(
                                turn.referenceImages.map((referenceImage, referenceIndex) => ({
                                  id: `${turn.id}-reference-${referenceIndex}`,
                                  src: referenceImage.dataUrl,
                                })),
                                index,
                              )
                            }
                            className="group relative h-20 w-20 overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-100/60 text-left transition hover:border-stone-300 sm:h-24 sm:w-24 sm:rounded-none"
                            aria-label={`预览参考图 ${image.name || index + 1}`}
                          >
                            <img
                              src={image.dataUrl}
                              alt={image.name || `参考图 ${index + 1}`}
                              className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                            />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 sm:mb-4 sm:gap-2 sm:text-xs">
                  <span className="rounded-full bg-stone-100 px-3 py-1">{turn.count} 张</span>
                  <span className="rounded-full bg-stone-100 px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                  {turn.status === "queued" && hasPendingPreviousTurn ? (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">等待当前对话中的前序任务完成</span>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 gap-2.5 sm:block sm:columns-2 sm:gap-4 sm:space-y-4 xl:columns-3">
                  {turn.images.map((image, index) => {
                    const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                    if (image.status === "success" && imageSrc) {
                      const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                      const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : "";
                      const dimensions = imageDimensions[image.id];
                      const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

                      return (
                        <div
                          key={image.id}
                          className="flex break-inside-avoid overflow-hidden rounded-2xl border border-stone-200/75 bg-white shadow-sm sm:block sm:rounded-none sm:border-0 sm:bg-transparent sm:shadow-none"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                            className="group relative block h-28 w-24 shrink-0 cursor-zoom-in overflow-hidden bg-stone-100 sm:h-auto sm:w-full sm:overflow-visible sm:bg-transparent"
                          >
                            <StoredImageElement
                              image={image}
                              fallbackSrc={imageSrc}
                              alt={`生成结果 ${index + 1}`}
                              className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:brightness-90 sm:static sm:block sm:h-auto sm:w-full sm:object-contain"
                              onLoad={(width, height) => {
                                updateImageDimensions(
                                  image.id,
                                  width,
                                  height,
                                );
                              }}
                            />
                          </button>
                          <div className="flex min-w-0 flex-1 flex-col justify-between px-3 py-2.5 sm:flex sm:flex-none sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-0 sm:py-2">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-stone-800 sm:inline-flex sm:h-7 sm:items-center sm:rounded-full sm:bg-white/80 sm:px-2.5 sm:text-xs sm:font-medium sm:text-stone-700 sm:ring-1 sm:ring-stone-200/80">
                                结果 {index + 1}
                              </div>
                              <button
                                type="button"
                                className={cn(
                                  "mt-1 block w-full cursor-pointer break-words text-left text-xs leading-5 text-stone-500 sm:hidden",
                                  !expandedPromptIds[`${turn.id}-${image.id}`] && "image-mobile-text-clamp-3",
                                )}
                                onClick={() => togglePromptExpanded(`${turn.id}-${image.id}`)}
                              >
                                {turn.prompt}
                              </button>
                            </div>
                            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 sm:mt-0 sm:justify-end">
                              {imageMeta ? <span className="min-w-0 break-words text-stone-400 sm:truncate">{imageMeta}</span> : null}
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (image.status === "error") {
                      return (
                        <div
                          key={image.id}
                          className="flex break-inside-avoid overflow-hidden rounded-2xl border border-rose-200 bg-rose-50 sm:block sm:rounded-none"
                          style={undefined}
                        >
                          <div
                            className="flex h-28 w-24 shrink-0 items-center justify-center bg-rose-100 text-rose-500 sm:h-auto sm:w-full"
                            style={getImageAspectStyle(turn.size)}
                          >
                            <Trash2 className="size-5" />
                          </div>
                          <div className="flex min-h-28 flex-1 flex-col justify-center gap-3 px-4 py-3 text-sm leading-6 text-rose-600 sm:min-h-16 sm:items-center sm:px-6 sm:py-8 sm:text-center">
                            <div className="line-clamp-2">{image.error || "生成失败"}</div>
                            <button
                              type="button"
                              className="inline-flex h-8 w-fit items-center gap-1.5 rounded-full bg-white px-3 text-xs font-medium text-rose-600 shadow-sm transition hover:bg-rose-100"
                              onClick={() => void onDeleteFailedImage(selectedConversation.id, turn.id, image.id)}
                            >
                              <Trash2 className="size-3.5" />
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={image.id}
                        className="flex break-inside-avoid overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-sm sm:block sm:rounded-none sm:bg-stone-100/80 sm:shadow-none"
                      >
                        <div
                          className="flex h-28 w-24 shrink-0 items-center justify-center bg-stone-100 text-stone-500 sm:h-auto sm:w-full"
                          style={getImageAspectStyle(turn.size)}
                        >
                          <div className="rounded-full bg-white p-3 shadow-sm">
                            {turn.status === "queued" ? (
                              <Clock3 className="size-5" />
                            ) : (
                              <LoaderCircle className="size-5 animate-spin" />
                            )}
                          </div>
                        </div>
                        <div className="flex min-h-28 flex-1 flex-col justify-center px-4 py-3 text-left text-stone-500 sm:h-full sm:items-center sm:px-6 sm:py-8 sm:text-center">
                          <p className="max-w-full px-1 text-xs leading-5 sm:text-sm">
                            {turn.status === "queued" ? "已加入当前对话队列..." : "正在后台处理图片，刷新不会中断..."}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {turn.status === "error" && turn.error ? (
                  <div className="mt-4 border-l-2 border-amber-300 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
                    {turn.error}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const ImageResults = memo(ImageResultsComponent);

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

function formatBase64ImageSize(base64: string) {
  const normalized = base64.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}
