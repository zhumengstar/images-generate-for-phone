"use client";

import { useEffect, useState } from "react";
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
  return image.url || "";
}

function base64ToObjectUrl(base64: string) {
  const normalized = base64.includes(",") ? base64.split(",", 2)[1] : base64;
  const byteCharacters = atob(normalized.replace(/\s/g, ""));
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < byteCharacters.length; offset += 8192) {
    const slice = byteCharacters.slice(offset, offset + 8192);
    const bytes = new Uint8Array(slice.length);
    for (let index = 0; index < slice.length; index += 1) {
      bytes[index] = slice.charCodeAt(index);
    }
    chunks.push(bytes);
  }
  return URL.createObjectURL(new Blob(chunks, { type: "image/png" }));
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
  const [objectUrl, setObjectUrl] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
    if (!image.b64_json) {
      setObjectUrl("");
      return;
    }

    try {
      const nextObjectUrl = base64ToObjectUrl(image.b64_json);
      setObjectUrl(nextObjectUrl);
      return () => URL.revokeObjectURL(nextObjectUrl);
    } catch {
      setObjectUrl("");
    }
  }, [image.b64_json]);

  if (loadFailed) {
    return (
      <div className="flex min-h-40 w-full items-center justify-center bg-stone-100 px-4 py-8 text-center text-sm text-stone-500">
        Load failed
      </div>
    );
  }

  return (
    <img
      src={objectUrl || fallbackSrc}
      alt={alt}
      className={className}
      onLoad={(event) => onLoad(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
      onError={() => setLoadFailed(true)}
    />
  );
}

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onDeleteFailedImage,
  formatConversationTime,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});

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
        <div className="w-full max-w-4xl">
          <h1
            className="text-[26px] font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Turn ideas into images
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
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 pb-1 sm:gap-8 sm:pb-0">
      {selectedConversation.turns.map((turn, turnIndex) => {
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
                <div className="break-words text-right">{turn.prompt}</div>
              </div>
            </div>

            <div className="flex justify-start">
              <div className="w-full p-0 sm:p-1">
                {turn.referenceImages.length > 0 ? (
                  <div className="mb-4 flex flex-col items-end">
                    <div className="mb-3 text-xs font-medium text-stone-500">本轮参考图</div>
                    <div className="flex flex-wrap justify-end gap-2 sm:gap-3">
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

                <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 sm:mb-4 sm:gap-2 sm:text-xs">
                  <span className="rounded-full bg-stone-100 px-3 py-1">{turn.count} 张</span>
                  <span className="rounded-full bg-stone-100 px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                  {turn.status === "queued" ? (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">等待当前对话中的前序任务完成</span>
                  ) : null}
                </div>

                <div className="columns-1 gap-3 space-y-3 sm:columns-2 sm:gap-4 sm:space-y-4 xl:columns-3">
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
                          className="break-inside-avoid overflow-hidden rounded-2xl border border-stone-200/75 bg-white shadow-sm sm:rounded-none sm:border-0 sm:bg-transparent sm:shadow-none"
                        >
                          <button
                            type="button"
                            onClick={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                            className="group block w-full cursor-zoom-in"
                          >
                            <StoredImageElement
                              image={image}
                              fallbackSrc={imageSrc}
                              alt={`Generated result ${index + 1}`}
                              className="block h-auto w-full transition duration-200 group-hover:brightness-90"
                              onLoad={(width, height) => {
                                updateImageDimensions(
                                  image.id,
                                  width,
                                  height,
                                );
                              }}
                            />
                          </button>
                          <div className="px-3 py-2.5 sm:py-3">
                            <div className="min-w-0 text-xs text-stone-500">
                              <span>结果 {index + 1}</span>
                              {imageMeta ? <span className="ml-2 text-stone-400">{imageMeta}</span> : null}
                            </div>
                          </div>
                        </div>
                      );
                    }

                    if (image.status === "error") {
                      return (
                        <div
                          key={image.id}
                          className={cn(
                            "break-inside-avoid overflow-hidden rounded-2xl border border-rose-200 bg-rose-50 sm:rounded-none",
                            turn.size === "1:1" && "sm:aspect-square",
                            turn.size === "16:9" && "sm:aspect-video",
                            turn.size === "9:16" && "sm:aspect-[9/16]",
                            turn.size === "4:3" && "sm:aspect-[4/3]",
                            turn.size === "3:4" && "sm:aspect-[3/4]",
                            !["1:1", "16:9", "9:16", "4:3", "3:4"].includes(turn.size) && "sm:aspect-square",
                          )}
                        >
                          <div className="flex h-full min-h-16 flex-col items-center justify-center gap-3 px-4 py-4 text-center text-sm leading-6 text-rose-600 sm:px-6 sm:py-8">
                            <div>{image.error || "生成失败"}</div>
                            <button
                              type="button"
                              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-medium text-rose-600 shadow-sm transition hover:bg-rose-100"
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
                        className={cn(
                          "break-inside-avoid overflow-hidden border border-stone-200/80 bg-stone-100/80",
                          turn.size === "1:1" && "aspect-square",
                          turn.size === "16:9" && "aspect-video",
                          turn.size === "9:16" && "aspect-[9/16]",
                          turn.size === "4:3" && "aspect-[4/3]",
                          turn.size === "3:4" && "aspect-[3/4]",
                          !["1:1", "16:9", "9:16", "4:3", "3:4"].includes(turn.size) && "aspect-square",
                        )}
                      >
                        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center text-stone-500">
                          <div className="rounded-full bg-white p-3 shadow-sm">
                            {turn.status === "queued" ? (
                              <Clock3 className="size-5" />
                            ) : (
                              <LoaderCircle className="size-5 animate-spin" />
                            )}
                          </div>
                          <p className="text-sm">
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
