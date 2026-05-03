"use client";
import { ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { StoredReferenceImage } from "@/store/image-conversations";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  availableQuota: string;
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

export function ImageComposer({
  prompt,
  imageCount,
  imageSize,
  availableQuota,
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
  const [sizeMenuStyle, setSizeMenuStyle] = useState<CSSProperties>({});
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const imageSizeOptions = [
    { value: "", label: "未指定" },
    { value: "1:1", label: "1:1 (正方形)" },
    { value: "21:9", label: "21:9 (超宽横版)" },
    { value: "16:9", label: "16:9 (横版)" },
    { value: "3:2", label: "3:2 (横版)" },
    { value: "4:3", label: "4:3 (横版)" },
    { value: "5:4", label: "5:4 (横版)" },
    { value: "4:5", label: "4:5 (竖版)" },
    { value: "3:4", label: "3:4 (竖版)" },
    { value: "2:3", label: "2:3 (竖版)" },
    { value: "9:16", label: "9:16 (竖版)" },
    { value: "9:21", label: "9:21 (超高竖版)" },
  ];
  const imageSizeLabel = imageSizeOptions.find((option) => option.value === imageSize)?.label || "未指定";

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const updateMenuPosition = () => {
      const rect = sizeMenuRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const menuWidth = window.innerWidth < 640 ? window.innerWidth - 32 : 220;
      const left = window.innerWidth < 640 ? 16 : Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12));
      setSizeMenuStyle({
        left,
        width: menuWidth,
        bottom: Math.max(12, window.innerHeight - rect.top + 10),
      });
    };
    const handlePointerDown = (event: MouseEvent) => {
      if (!sizeMenuRef.current?.contains(event.target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    updateMenuPosition();
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isSizeMenuOpen]);

  return (
    <div className="relative z-20 flex shrink-0 justify-center border-t border-stone-200/80 bg-stone-50/95 px-2 pt-2 backdrop-blur sm:border-t-0 sm:bg-transparent sm:px-0 sm:pt-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <div className="overflow-hidden rounded-[22px] border border-stone-200 bg-white shadow-[0_14px_60px_-42px_rgba(15,23,42,0.45)] sm:rounded-[32px] sm:shadow-none">
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
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              placeholder="输入你想要生成的画面"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className={cn(
                "max-h-[28dvh] min-h-[68px] resize-none rounded-[22px] border-0 bg-transparent px-4 pt-3 pr-14 pb-2 text-[16px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:max-h-none sm:min-h-[148px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pr-20 sm:pb-20 sm:text-[15px] sm:leading-7",
                referenceImages.length > 0 && "min-h-[132px] pb-[76px] sm:pb-20",
              )}
            />
            <button
              type="button"
              className="absolute top-3 right-3 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-[11px] font-medium text-amber-700 shadow-sm transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 sm:top-5 sm:right-5 sm:h-9 sm:px-3 sm:text-xs"
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

            {referenceImages.length > 0 ? (
              <div className="hide-scrollbar absolute inset-x-3 bottom-[58px] z-10 flex gap-1.5 overflow-x-auto pr-12 sm:inset-x-6 sm:bottom-[68px] sm:pr-6">
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
            ) : null}

            <div className="border-t border-stone-100 bg-white px-3 pb-3 pt-2 sm:absolute sm:inset-x-0 sm:bottom-0 sm:border-t-0 sm:bg-gradient-to-t sm:from-white sm:via-white/95 sm:to-transparent sm:px-6 sm:pb-4 sm:pt-6" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium transition sm:px-3 sm:text-xs",
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
                  <div className="shrink-0 rounded-full bg-stone-100 px-2.5 py-1.5 text-[10px] font-medium text-stone-600 sm:px-3 sm:py-2 sm:text-xs">
                    <span className="hidden sm:inline">剩余额度 </span>{availableQuota}
                  </div>
                  {runningTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1.5 text-[10px] font-medium text-amber-700 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      <LoaderCircle className="size-3 animate-spin" />
                      {runningTaskCount}<span className="hidden sm:inline"> 个处理中</span>
                    </div>
                  )}
                  {queuedTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1.5 text-[10px] font-medium text-stone-600 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      {queuedTaskCount}<span className="hidden sm:inline"> 个排队中</span>
                    </div>
                  )}
                  <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 sm:h-auto sm:gap-2 sm:px-3 sm:py-1">
                    <span className="text-[11px] font-medium text-stone-700 sm:text-sm">张数</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="2"
                      step="1"
                      value={imageCount}
                      onChange={(event) => onImageCountChange(event.target.value)}
                      className="h-7 w-[40px] border-0 bg-transparent px-0 text-center text-xs font-medium text-stone-700 shadow-none focus-visible:ring-0 sm:h-8 sm:w-[64px] sm:text-sm"
                    />
                  </div>
                  <div
                    ref={sizeMenuRef}
                    className="relative flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-[11px] sm:h-auto sm:gap-2 sm:px-3 sm:py-1 sm:text-[13px]"
                  >
                    <span className="font-medium text-stone-700 sm:text-sm">比例</span>
                    <button
                      type="button"
                      className="flex h-7 w-[78px] items-center justify-between bg-transparent text-left text-xs font-bold text-stone-700 min-[390px]:w-[96px] sm:h-8 sm:w-[132px]"
                      onClick={() => setIsSizeMenuOpen((open) => !open)}
                    >
                      <span className="truncate">{imageSizeLabel}</span>
                      <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
                    </button>
                    {isSizeMenuOpen ? (
                      <div
                        className="fixed z-[100] max-h-[45dvh] overflow-y-auto rounded-3xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)]"
                        style={sizeMenuStyle}
                      >
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
                              onClick={() => {
                                onImageSizeChange(option.value);
                                setIsSizeMenuOpen(false);
                              }}
                            >
                              <span>{option.label}</span>
                              {active ? <Check className="size-4" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white shadow-sm transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:size-11"
                  aria-label="生成图片"
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

