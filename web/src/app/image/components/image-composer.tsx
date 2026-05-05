"use client";
import { ArrowUp, Check, ChevronDown, ChevronUp, ImagePlus, LoaderCircle, Maximize2, Minimize2, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { StoredReferenceImage } from "@/store/image-conversations";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  quotaLabel?: string;
  queuedTaskCount: number;
  runningTaskCount: number;
  isPolishingPrompt: boolean;
  referenceImages: StoredReferenceImage[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
  onPolishPrompt: () => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
};

function getAspectPreviewStyle(value: string): CSSProperties {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) {
    return { width: 88, height: 88 };
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 88, height: 88 };
  }

  const maxWidth = 128;
  const maxHeight = 96;
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.max(24, width * scale),
    height: Math.max(24, height * scale),
  };
}

function getAspectThumbnailStyle(value: string): CSSProperties {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) {
    return { width: 22, height: 22 };
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 22, height: 22 };
  }

  const maxWidth = 34;
  const maxHeight = 24;
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.max(8, width * scale),
    height: Math.max(8, height * scale),
  };
}

export function ImageComposer({
  prompt,
  imageCount,
  imageSize,
  quotaLabel,
  queuedTaskCount,
  runningTaskCount,
  isPolishingPrompt,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
  onReferenceImageChange,
  onRemoveReferenceImage,
  onPolishPrompt,
  onSubmit,
}: ImageComposerProps) {
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [hoveredSizeValue, setHoveredSizeValue] = useState<string | null>(null);
  const imageSizeOptions = [
    { value: "", label: "未指定", description: "" },
    { value: "1:1", label: "1:1 (正方形)", description: "正方形" },
    { value: "21:9", label: "21:9 (超宽横版)", description: "超宽横版" },
    { value: "16:9", label: "16:9 (横版)", description: "横版" },
    { value: "3:2", label: "3:2 (横版)", description: "横版" },
    { value: "4:3", label: "4:3 (横版)", description: "横版" },
    { value: "5:4", label: "5:4 (横版)", description: "横版" },
    { value: "4:5", label: "4:5 (竖版)", description: "竖版" },
    { value: "3:4", label: "3:4 (竖版)", description: "竖版" },
    { value: "2:3", label: "2:3 (竖版)", description: "竖版" },
    { value: "9:16", label: "9:16 (竖版)", description: "竖版" },
    { value: "9:21", label: "9:21 (超高竖版)", description: "超高竖版" },
  ];
  const selectedSizeOption = imageSizeOptions.find((option) => option.value === imageSize) || imageSizeOptions[0];
  const imageSizeValueLabel = selectedSizeOption.value || selectedSizeOption.label;
  const previewSizeOption =
    imageSizeOptions.find((option) => option.value === hoveredSizeValue) || selectedSizeOption;
  const previewAspectStyle = getAspectPreviewStyle(previewSizeOption.value);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [isComposerCollapsed, setIsComposerCollapsed] = useState(false);
  const [desktopPromptHeight, setDesktopPromptHeight] = useState<number | null>(null);
  const lastPromptExpandedRef = useRef(isPromptExpanded);
  const promptResizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const shouldExpandPromptInput = prompt.trim().length > 80 || prompt.includes("\n");

  const markPromptFocused = useCallback(() => {
    if (typeof window === "undefined" || window.innerWidth >= 640) {
      return;
    }

    document.documentElement.classList.add("image-keyboard-active");
  }, []);

  const resetComposerPlacement = useCallback(() => {
    document.documentElement.classList.remove("image-keyboard-active");
    document.documentElement.style.setProperty("--image-composer-keyboard-offset", "0px");
  }, []);

  const expandMobileComposer = useCallback(() => {
    setIsComposerCollapsed(false);
    window.setTimeout(() => {
      textareaRef.current?.focus({ preventScroll: true });
    }, 0);
  }, [textareaRef]);

  const collapseMobileComposer = useCallback(() => {
    if (typeof window !== "undefined" && window.innerWidth >= 640) {
      const textareaHeight = textareaRef.current?.getBoundingClientRect().height;
      if (textareaHeight) {
        setDesktopPromptHeight(Math.round(textareaHeight));
      }
    }

    setIsPromptExpanded(false);
    setIsSizeMenuOpen(false);
    setIsComposerCollapsed(true);
    textareaRef.current?.blur();
    resetComposerPlacement();
  }, [resetComposerPlacement, textareaRef]);

  const resizePromptTextarea = useCallback((force = false) => {
    if (typeof window === "undefined") {
      return;
    }
    if (!force && window.innerWidth < 640 && document.documentElement.classList.contains("image-keyboard-active")) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const isDesktop = window.innerWidth >= 640;
    const isLargeDesktop = window.innerWidth >= 1024;
    const minHeight = isPromptExpanded
      ? isDesktop
        ? isLargeDesktop
          ? 220
          : 260
        : 188
      : shouldExpandPromptInput
        ? isDesktop
          ? isLargeDesktop
            ? 156
            : 188
          : 128
        : isDesktop
          ? isLargeDesktop
            ? 112
            : 148
          : 68;
    const maxHeight = Math.round(window.innerHeight * (isPromptExpanded ? 0.52 : shouldExpandPromptInput ? 0.4 : 0.28));

    if (isDesktop && desktopPromptHeight !== null) {
      const clampedHeight = Math.max(minHeight, Math.min(desktopPromptHeight, Math.round(window.innerHeight * 0.52)));
      textarea.style.height = `${clampedHeight}px`;
      if (clampedHeight !== desktopPromptHeight) {
        setDesktopPromptHeight(clampedHeight);
      }
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
  }, [desktopPromptHeight, isPromptExpanded, shouldExpandPromptInput, textareaRef]);

  useLayoutEffect(() => {
    const forceResize = lastPromptExpandedRef.current !== isPromptExpanded;
    lastPromptExpandedRef.current = isPromptExpanded;
    resizePromptTextarea(forceResize);
  }, [isPromptExpanded, prompt, referenceImages.length, resizePromptTextarea]);

  const togglePromptExpanded = useCallback(() => {
    setDesktopPromptHeight(null);
    setIsPromptExpanded((current) => !current);
  }, []);

  const handlePromptResizePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (typeof window === "undefined" || window.innerWidth < 640) {
      return;
    }

    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setIsPromptExpanded(false);
    promptResizeDragRef.current = {
      startY: event.clientY,
      startHeight: textarea.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [textareaRef]);

  const handlePromptResizePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (typeof window === "undefined") {
      return;
    }

    const drag = promptResizeDragRef.current;
    if (!drag) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const minHeight = window.innerWidth >= 1024 ? 112 : 148;
    const maxHeight = Math.round(window.innerHeight * 0.52);
    const nextHeight = Math.max(minHeight, Math.min(drag.startHeight + drag.startY - event.clientY, maxHeight));
    setDesktopPromptHeight(Math.round(nextHeight));
  }, []);

  const handlePromptResizePointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!promptResizeDragRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    promptResizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.addEventListener("resize", resizePromptTextarea);
    window.addEventListener("orientationchange", resizePromptTextarea);
    return () => {
      window.removeEventListener("resize", resizePromptTextarea);
      window.removeEventListener("orientationchange", resizePromptTextarea);
    };
  }, [resizePromptTextarea]);

  return (
    <div
      className="image-mobile-composer z-50 flex shrink-0 justify-center border-t border-stone-200/80 bg-white backdrop-blur sm:relative sm:inset-auto sm:z-20 sm:translate-y-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:pt-0 sm:pb-0 lg:pt-3"
    >
      <div style={{ width: "min(980px, 100%)" }}>
        <div className={cn(
          "overflow-hidden border-t border-stone-200 bg-white shadow-none sm:rounded-[32px] sm:border lg:rounded-[22px] lg:border-stone-200/70 lg:shadow-[0_18px_60px_-36px_rgba(68,64,60,0.55)]",
        )}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              void onReferenceImageChange(Array.from(event.target.files || []));
            }}
          />
          <div className="flex flex-col bg-white">
            {isComposerCollapsed ? (
              <section
                className="relative hidden border-b border-stone-100 bg-white sm:block sm:h-[148px] lg:h-[112px]"
                style={desktopPromptHeight !== null ? { height: desktopPromptHeight } : undefined}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 border-t border-stone-100 bg-white px-6 py-3 lg:px-5">
                  <div className="flex min-w-0 flex-1 items-center gap-3 overflow-visible">
                    <button
                      type="button"
                      className={cn(
                        "inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-0 text-[11px] font-medium transition sm:px-3 sm:text-xs",
                        referenceImages.length > 0
                          ? "border-stone-900 bg-stone-950 text-white"
                          : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50",
                      )}
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="上传参考图"
                    >
                      <ImagePlus className="size-3.5" />
                    </button>
                    {quotaLabel ? (
                      <div className="inline-flex h-9 shrink-0 items-center rounded-full bg-stone-950 px-3 text-xs font-medium text-white lg:px-4">
                        <span className="font-mono tracking-normal lg:text-[13px]">{quotaLabel}</span>
                      </div>
                    ) : null}
                    <div className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1 lg:px-4">
                      <span className="text-sm font-medium text-stone-700">张数</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="2"
                        step="1"
                        value={imageCount}
                        onChange={(event) => onImageCountChange(event.target.value)}
                        className="h-8 w-[64px] border-0 bg-transparent px-0 text-center text-sm font-medium text-stone-700 shadow-none focus-visible:ring-0"
                      />
                    </div>
                    <PopoverPrimitive.Root
                      open={isSizeMenuOpen}
                      onOpenChange={(open) => {
                        setIsSizeMenuOpen(open);
                        if (!open) {
                          setHoveredSizeValue(null);
                        }
                      }}
                    >
                      <div className="relative flex h-9 min-w-0 shrink items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1 text-[13px] lg:px-4">
                        <span className="text-sm font-medium text-stone-700">比例</span>
                        <PopoverPrimitive.Trigger asChild>
                          <button
                            type="button"
                            className="flex h-8 w-[132px] min-w-0 items-center justify-between gap-1 bg-transparent text-left text-xs font-bold text-stone-700"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              <span>{imageSizeValueLabel}</span>
                              {selectedSizeOption.description ? <span> {selectedSizeOption.description}</span> : null}
                            </span>
                            <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
                          </button>
                        </PopoverPrimitive.Trigger>
                      </div>
                      <PopoverPrimitive.Portal>
                        <PopoverPrimitive.Content
                          side="top"
                          align="center"
                          sideOffset={10}
                          collisionPadding={12}
                          className="z-[100] hidden max-h-[min(48dvh,420px)] w-[380px] overflow-hidden rounded-3xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)] sm:block"
                          onOpenAutoFocus={(event) => event.preventDefault()}
                        >
                          <div className="grid grid-cols-[178px_minmax(0,1fr)] gap-2">
                            <div className="max-h-[min(48dvh,404px)] overflow-y-auto pr-1">
                              {imageSizeOptions.map((option) => {
                                const active = option.value === imageSize;
                                return (
                                  <button
                                    key={option.label}
                                    type="button"
                                    className={cn(
                                      "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm text-stone-700 transition hover:bg-stone-100",
                                      active && "bg-stone-100 font-medium text-stone-950",
                                    )}
                                    onMouseEnter={() => setHoveredSizeValue(option.value)}
                                    onFocus={() => setHoveredSizeValue(option.value)}
                                    onClick={() => {
                                      onImageSizeChange(option.value);
                                      setIsSizeMenuOpen(false);
                                      setHoveredSizeValue(null);
                                    }}
                                  >
                                    <span className="min-w-0 flex-1 truncate pr-2">{option.label}</span>
                                    <span className="flex h-7 w-10 shrink-0 items-center justify-center rounded-lg border border-stone-200 bg-white shadow-inner" aria-hidden="true">
                                      <span
                                        className="rounded-[3px] border border-stone-400 bg-stone-100"
                                        style={getAspectThumbnailStyle(option.value)}
                                      />
                                    </span>
                                    {active ? <Check className="ml-1 size-4 shrink-0" /> : null}
                                  </button>
                                );
                              })}
                            </div>
                            <div className="flex min-h-[178px] flex-col items-center justify-center rounded-2xl bg-stone-50 p-3">
                              <div className="mb-3 text-center text-xs font-medium text-stone-500">
                                {previewSizeOption.label}
                              </div>
                              <div className="flex h-28 w-full items-center justify-center rounded-xl border border-stone-200 bg-white p-3 shadow-inner">
                                <div
                                  className="max-h-full max-w-full rounded-md border border-stone-300 bg-[linear-gradient(135deg,rgba(214,211,209,0.55)_25%,transparent_25%),linear-gradient(225deg,rgba(214,211,209,0.55)_25%,transparent_25%),linear-gradient(45deg,rgba(214,211,209,0.55)_25%,transparent_25%),linear-gradient(315deg,rgba(214,211,209,0.55)_25%,#fff_25%)] bg-[length:16px_16px] bg-[position:8px_0,8px_0,0_0,0_0] shadow-sm"
                                  style={previewAspectStyle}
                                />
                              </div>
                            </div>
                          </div>
                        </PopoverPrimitive.Content>
                      </PopoverPrimitive.Portal>
                    </PopoverPrimitive.Root>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-11 w-11 min-w-11 aspect-square shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white p-0 text-stone-700 shadow-sm transition hover:bg-stone-50 hover:text-stone-950"
                    onClick={expandMobileComposer}
                    aria-label="展开输入区"
                    title="展开输入区"
                  >
                    <ChevronUp className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={!prompt.trim()}
                    className="inline-flex h-11 w-11 min-w-11 aspect-square shrink-0 items-center justify-center rounded-full bg-stone-950 p-0 text-white shadow-sm transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
                    aria-label="生成图片"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                </div>
              </section>
            ) : (
              <section
                className="relative cursor-text"
                onClick={() => {
                  textareaRef.current?.focus({ preventScroll: true });
                }}
              >
              <Textarea
                ref={textareaRef}
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                onFocus={() => {
                  markPromptFocused();
                }}
                onBlur={() => {
                  resetComposerPlacement();
                }}
                placeholder="输入你想要生成的画面"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void onSubmit();
                  }
                }}
                className={cn(
                  "max-h-[28dvh] min-h-[68px] resize-none overflow-y-auto rounded-none border-0 bg-transparent px-4 pt-3 pr-14 pb-12 text-[16px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:max-h-[40dvh] sm:min-h-[148px] sm:overflow-y-auto sm:px-6 sm:pt-6 sm:pr-24 sm:pb-14 sm:text-[15px] sm:leading-7 lg:max-h-[28dvh] lg:min-h-[112px] lg:pt-4 lg:pb-11 lg:leading-6",
                  shouldExpandPromptInput && "max-h-[40dvh] min-h-[128px] sm:min-h-[188px] lg:min-h-[156px]",
                  isPromptExpanded && "max-h-[52dvh] min-h-[188px] sm:max-h-[52dvh] sm:min-h-[260px] lg:min-h-[220px]",
                  desktopPromptHeight !== null && "sm:max-h-[52dvh] sm:min-h-[148px] lg:max-h-[52dvh] lg:min-h-[112px]",
                )}
              />
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="调整输入框高度"
                title="调整输入框高度"
                className="group absolute left-4 right-28 top-0 z-20 hidden h-3 cursor-ns-resize touch-none items-start sm:flex"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={handlePromptResizePointerDown}
                onPointerMove={handlePromptResizePointerMove}
                onPointerUp={handlePromptResizePointerEnd}
                onPointerCancel={handlePromptResizePointerEnd}
              >
                <span className="mt-[-1px] h-1 w-full rounded-full bg-stone-300/0 transition group-hover:bg-stone-300/70" />
              </div>
              <button
                type="button"
                className="absolute right-3 top-3 z-10 inline-flex size-8 items-center justify-center rounded-full border border-stone-200 bg-white/95 text-stone-600 shadow-sm backdrop-blur transition hover:bg-stone-100 hover:text-stone-950 sm:right-5 sm:top-5 sm:size-9"
                onClick={(event) => {
                  event.stopPropagation();
                  togglePromptExpanded();
                }}
                aria-label={isPromptExpanded ? "缩小输入框" : "放大输入框"}
                title={isPromptExpanded ? "缩小输入框" : "放大输入框"}
              >
                {isPromptExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              </button>
              <button
                type="button"
                className="absolute right-12 top-3 z-10 inline-flex size-8 items-center justify-center rounded-full border border-stone-200 bg-white/95 text-stone-600 shadow-sm backdrop-blur transition hover:bg-stone-100 hover:text-stone-950 sm:right-16 sm:top-5 sm:size-9"
                onClick={(event) => {
                  event.stopPropagation();
                  collapseMobileComposer();
                }}
                aria-label="收起输入区"
                title="收起输入区"
              >
                <ChevronDown className="size-3.5" />
              </button>
              <button
                type="button"
                className="absolute right-3 bottom-3 z-10 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50/95 px-2.5 text-[11px] font-medium text-amber-700 shadow-sm backdrop-blur transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 sm:right-5 sm:bottom-4 sm:h-9 sm:px-3 sm:text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  void onPolishPrompt();
                }}
                disabled={!prompt.trim() || isPolishingPrompt}
                aria-label="AI润色"
              >
                {isPolishingPrompt ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                <span className="hidden min-[390px]:inline">AI润色</span>
              </button>
              </section>
            )}

            {!isComposerCollapsed && referenceImages.length > 0 ? (
              <section
                className="flex min-h-12 items-center gap-2 border-t border-stone-100 bg-white px-3 py-2 sm:min-h-14 sm:px-6 sm:py-3"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="hide-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto pr-1">
                  {referenceImages.map((image, index) => (
                    <div
                      key={`${image.name}-${index}`}
                      className="group relative size-11 shrink-0 overflow-hidden rounded-xl border border-white bg-stone-100 shadow-sm ring-1 ring-stone-200/80 sm:size-12"
                    >
                      <img src={image.dataUrl} alt={image.name || `参考图 ${index + 1}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        className="absolute right-0.5 top-0.5 inline-flex size-4 items-center justify-center rounded-full bg-black/70 text-white opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveReferenceImage(index);
                        }}
                        aria-label="移除参考图"
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section
              className={cn(
                "touch-manipulation overscroll-contain border-t border-stone-100 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2 sm:bg-white sm:px-6 sm:pb-4 sm:pt-3 lg:px-5 lg:pb-3",
                isComposerCollapsed && "sm:hidden",
              )}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-end justify-between gap-2 sm:gap-3 lg:gap-4">
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0 lg:gap-4">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full border px-0 text-[11px] font-medium transition min-[390px]:w-auto min-[390px]:px-3 sm:px-3 sm:text-xs",
                      referenceImages.length > 0
                        ? "border-stone-900 bg-stone-950 text-white"
                        : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50",
                    )}
                    onClick={() => fileInputRef.current?.click()}
                    aria-label="上传参考图"
                  >
                    <ImagePlus className="size-3.5" />
                    {referenceImages.length > 0 ? referenceImages.length : ""}
                  </button>
                  {quotaLabel ? (
                    <div className="hidden h-9 shrink-0 items-center rounded-full bg-stone-950 px-3 text-xs font-medium text-white sm:inline-flex lg:px-4">
                      <span className="font-mono tracking-normal lg:text-[13px]">{quotaLabel}</span>
                    </div>
                  ) : null}
                  {runningTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-1.5 text-[10px] font-medium text-amber-700 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      <LoaderCircle className="size-3 animate-spin" />
                      {runningTaskCount}<span className="hidden sm:inline"> 个处理中</span>
                    </div>
                  )}
                  {queuedTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2 py-1.5 text-[10px] font-medium text-stone-600 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      {queuedTaskCount}<span className="hidden sm:inline"> 个排队中</span>
                    </div>
                  )}
                  <div className="flex h-9 shrink-0 items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5 sm:h-auto sm:gap-2 sm:px-3 sm:py-1 lg:px-4">
                    <span className="text-[11px] font-medium text-stone-700 sm:text-sm">张数</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="2"
                      step="1"
                      value={imageCount}
                      onChange={(event) => onImageCountChange(event.target.value)}
                      className="h-7 w-[24px] border-0 bg-transparent px-0 text-center text-xs font-medium text-stone-700 shadow-none focus-visible:ring-0 min-[390px]:w-[30px] sm:h-8 sm:w-[64px] sm:text-sm"
                    />
                  </div>
                  <PopoverPrimitive.Root
                    open={isSizeMenuOpen}
                    onOpenChange={(open) => {
                      setIsSizeMenuOpen(open);
                      if (!open) {
                        setHoveredSizeValue(null);
                      }
                    }}
                  >
                    <div className="relative flex h-9 min-w-[118px] shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-[11px] min-[390px]:min-w-[128px] sm:h-auto sm:gap-2 sm:px-3 sm:py-1 sm:text-[13px] lg:px-4">
                      <span className="shrink-0 whitespace-nowrap font-medium text-stone-700 sm:text-sm">比例</span>
                      <PopoverPrimitive.Trigger asChild>
                        <button
                          type="button"
                          className="flex h-7 min-w-0 flex-1 items-center justify-between gap-1 bg-transparent text-left text-[11px] font-bold text-stone-700 sm:h-8 sm:w-[132px] sm:flex-none sm:text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            <span>{imageSizeValueLabel}</span>
                            {selectedSizeOption.description ? (
                              <span className="hidden sm:inline"> {selectedSizeOption.description}</span>
                            ) : null}
                          </span>
                          <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
                        </button>
                      </PopoverPrimitive.Trigger>
                    </div>
                    <PopoverPrimitive.Portal>
                      <PopoverPrimitive.Content
                        side="top"
                        align="center"
                        sideOffset={10}
                        collisionPadding={12}
                        className="z-[100] max-h-[min(42dvh,340px)] w-[min(calc(100vw-2rem),260px)] overflow-hidden rounded-2xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)] sm:max-h-[min(48dvh,420px)] sm:w-[380px] sm:rounded-3xl"
                        onOpenAutoFocus={(event) => event.preventDefault()}
                      >
                        <div className="sm:grid sm:grid-cols-[178px_minmax(0,1fr)] sm:gap-2">
                          <div className="max-h-[min(42dvh,324px)] overflow-y-auto pr-0 sm:max-h-[min(48dvh,404px)] sm:pr-1">
                            {imageSizeOptions.map((option) => {
                              const active = option.value === imageSize;
                              return (
                                <button
                                  key={option.label}
                                  type="button"
                                  className={cn(
                                    "flex h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-stone-700 transition hover:bg-stone-100 sm:h-auto sm:rounded-2xl",
                                    active && "bg-stone-100 font-medium text-stone-950",
                                  )}
                                  onMouseEnter={() => setHoveredSizeValue(option.value)}
                                  onFocus={() => setHoveredSizeValue(option.value)}
                                  onClick={() => {
                                    onImageSizeChange(option.value);
                                    setIsSizeMenuOpen(false);
                                    setHoveredSizeValue(null);
                                  }}
                                >
                                  <span className="min-w-0 flex-1 truncate pr-2">{option.label}</span>
                                  <span className="flex h-7 w-10 shrink-0 items-center justify-center rounded-lg border border-stone-200 bg-white shadow-inner" aria-hidden="true">
                                    <span
                                      className="rounded-[3px] border border-stone-400 bg-stone-100"
                                      style={getAspectThumbnailStyle(option.value)}
                                    />
                                  </span>
                                  {active ? <Check className="ml-1 size-4 shrink-0" /> : null}
                                </button>
                              );
                            })}
                          </div>
                          <div className="hidden rounded-2xl bg-stone-50 p-3 sm:flex sm:min-h-[178px] sm:flex-col sm:items-center sm:justify-center">
                            <div className="mb-3 text-center text-xs font-medium text-stone-500">
                              {previewSizeOption.label}
                            </div>
                            <div className="flex h-28 w-full items-center justify-center rounded-xl border border-stone-200 bg-white p-3 shadow-inner">
                              <div
                                className="max-h-full max-w-full rounded-md border border-stone-300 bg-[linear-gradient(135deg,rgba(214,211,209,0.55)_25%,transparent_25%),linear-gradient(225deg,rgba(214,211,209,0.55)_25%,transparent_25%),linear-gradient(45deg,rgba(214,211,209,0.55)_25%,transparent_25%),linear-gradient(315deg,rgba(214,211,209,0.55)_25%,#fff_25%)] bg-[length:16px_16px] bg-[position:8px_0,8px_0,0_0,0_0] shadow-sm"
                                style={previewAspectStyle}
                              />
                            </div>
                          </div>
                        </div>
                      </PopoverPrimitive.Content>
                    </PopoverPrimitive.Portal>
                  </PopoverPrimitive.Root>

                </div>

                {isComposerCollapsed ? (
                  <button
                    type="button"
                    className="inline-flex h-11 w-11 min-w-11 aspect-square shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white p-0 text-stone-700 shadow-sm transition hover:bg-stone-50 hover:text-stone-950 sm:h-11 sm:w-11"
                    onClick={expandMobileComposer}
                    aria-label="展开输入区"
                    title="展开输入区"
                  >
                    <ChevronUp className="size-3.5 sm:size-4" />
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex h-11 w-11 min-w-11 aspect-square shrink-0 items-center justify-center rounded-full bg-stone-950 p-0 text-white shadow-sm transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:h-11 sm:w-11"
                  aria-label="生成图片"
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

