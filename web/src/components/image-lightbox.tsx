"use client";

import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Minus, Plus, RotateCcw, X } from "lucide-react";

import { cn } from "@/lib/utils";

type LightboxImage = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
};

export function ImageLightbox({
  images,
  currentIndex,
  open,
  onOpenChange,
  onIndexChange,
}: ImageLightboxProps) {
  const current = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const didDragRef = useRef(false);

  const clampZoom = useCallback((value: number) => Math.min(5, Math.max(1, value)), []);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  }, []);

  const updateZoom = useCallback(
    (nextZoom: number) => {
      const clamped = clampZoom(nextZoom);
      setZoom(clamped);
      if (clamped <= 1) {
        setOffset({ x: 0, y: 0 });
      }
    },
    [clampZoom],
  );

  const goPrev = useCallback(() => {
    if (hasPrev) {
      resetZoom();
      onIndexChange(currentIndex - 1);
    }
  }, [hasPrev, currentIndex, onIndexChange, resetZoom]);

  const goNext = useCallback(() => {
    if (hasNext) {
      resetZoom();
      onIndexChange(currentIndex + 1);
    }
  }, [hasNext, currentIndex, onIndexChange, resetZoom]);

  useEffect(() => {
    resetZoom();
  }, [current?.id, open, resetZoom]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        updateZoom(zoom + 0.25);
      } else if (e.key === "-") {
        e.preventDefault();
        updateZoom(zoom - 0.25);
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext, resetZoom, updateZoom, zoom]);

  const handleDownload = useCallback(() => {
    if (!current) return;
    const link = document.createElement("a");
    link.href = current.src;
    link.download = `image-${current.id}.png`;
    link.click();
  }, [current]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.preventDefault();
      updateZoom(zoom + (event.deltaY < 0 ? 0.25 : -0.25));
    },
    [updateZoom, zoom],
  );

  if (!current) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center outline-none"
          onClick={() => onOpenChange(false)}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            图片预览
          </DialogPrimitive.Title>

          {/* toolbar */}
          <div className="absolute top-4 right-4 z-10 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {current.sizeLabel || current.dimensions ? (
              <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
                {[current.sizeLabel, current.dimensions].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            {images.length > 1 && (
              <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
                {currentIndex + 1} / {images.length}
              </span>
            )}
            <button
              type="button"
              onClick={() => updateZoom(zoom - 0.25)}
              disabled={zoom <= 1}
              className="hidden size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-40 sm:inline-flex"
              aria-label="缩小图片"
            >
              <Minus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => updateZoom(zoom + 0.25)}
              className="hidden size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70 sm:inline-flex"
              aria-label="放大图片"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={resetZoom}
              className="hidden h-9 items-center gap-1.5 rounded-full bg-black/50 px-3 text-xs font-medium text-white/90 transition hover:bg-black/70 sm:inline-flex"
              aria-label="还原图片大小"
            >
              <RotateCcw className="size-4" />
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70"
              aria-label="下载图片"
            >
              <Download className="size-4" />
            </button>
            <DialogPrimitive.Close className="inline-flex size-9 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70">
              <X className="size-4" />
              <span className="sr-only">关闭</span>
            </DialogPrimitive.Close>
          </div>

          {/* prev */}
          {hasPrev && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                goPrev();
              }}
              className="absolute left-4 z-10 inline-flex size-10 items-center justify-center rounded-full bg-black/40 text-white/90 transition hover:bg-black/60"
              aria-label="上一张"
            >
              <ChevronLeft className="size-5" />
            </button>
          )}

          {/* image */}
          <div
            className="flex max-h-[78dvh] max-w-[86vw] items-center justify-center sm:max-h-[90vh] sm:max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
            onWheel={handleWheel}
          >
            <img
              src={current.src}
              alt=""
              className={cn(
                "max-h-[78dvh] max-w-[86vw] select-none rounded-lg object-contain transition-transform duration-150 sm:max-h-[90vh] sm:max-w-[90vw]",
                zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
              )}
              style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }}
              onClick={(e) => {
                e.stopPropagation();
                if (didDragRef.current) {
                  didDragRef.current = false;
                  return;
                }
                updateZoom(zoom > 1 ? 1 : 2);
              }}
              onPointerDown={(event) => {
                if (zoom <= 1) {
                  return;
                }
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: offset.x,
                  originY: offset.y,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || drag.pointerId !== event.pointerId) {
                  return;
                }
                event.stopPropagation();
                if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
                  drag.moved = true;
                  didDragRef.current = true;
                }
                setOffset({
                  x: drag.originX + event.clientX - drag.startX,
                  y: drag.originY + event.clientY - drag.startY,
                });
              }}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId === event.pointerId) {
                  didDragRef.current = dragRef.current.moved;
                  dragRef.current = null;
                }
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
              draggable={false}
            />
          </div>

          {/* next */}
          {hasNext && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                goNext();
              }}
              className="absolute right-4 z-10 inline-flex size-10 items-center justify-center rounded-full bg-black/40 text-white/90 transition hover:bg-black/60"
              aria-label="下一张"
            >
              <ChevronRight className="size-5" />
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
