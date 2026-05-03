"use client";
import { ArrowUp, Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  availableQuota: string;
  activeTaskCount: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
};

export function ImageComposer({
  prompt,
  imageCount,
  imageSize,
  availableQuota,
  activeTaskCount,
  textareaRef,
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
  onSubmit,
}: ImageComposerProps) {
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const imageSizeOptions = [
    { value: "", label: "未指定" },
    { value: "1:1", label: "1:1 (正方形)" },
    { value: "16:9", label: "16:9 (横版)" },
    { value: "4:3", label: "4:3 (横版)" },
    { value: "3:4", label: "3:4 (竖版)" },
    { value: "9:16", label: "9:16 (竖版)" },
  ];
  const imageSizeLabel = imageSizeOptions.find((option) => option.value === imageSize)?.label || "未指定";

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!sizeMenuRef.current?.contains(event.target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <div className="rounded-[24px] border border-stone-200 bg-white shadow-[0_14px_60px_-42px_rgba(15,23,42,0.45)] sm:rounded-[32px] sm:shadow-none">
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
              className="min-h-[82px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[148px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pb-20 sm:leading-7"
            />

            <div className="border-t border-stone-100 bg-white px-3 pb-3 pt-2 sm:absolute sm:inset-x-0 sm:bottom-0 sm:border-t-0 sm:bg-gradient-to-t sm:from-white sm:via-white/95 sm:to-transparent sm:px-6 sm:pb-4 sm:pt-6" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
                  <div className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-600 sm:px-3 sm:py-2 sm:text-xs">
                    <span className="hidden sm:inline">剩余额度 </span>{availableQuota}
                  </div>
                  {activeTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount}<span className="hidden sm:inline"> 个任务处理中</span>
                    </div>
                  )}
                  <div className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 sm:h-auto sm:gap-2 sm:px-3 sm:py-1">
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
                    className="relative flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] sm:h-auto sm:gap-2 sm:px-3 sm:py-1 sm:text-[13px]"
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
                      <div className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] z-[80] max-h-[45dvh] overflow-y-auto rounded-3xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)] sm:absolute sm:inset-x-auto sm:bottom-[calc(100%+10px)] sm:left-0 sm:w-[186px]">
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
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:size-11"
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

