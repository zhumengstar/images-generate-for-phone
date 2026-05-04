"use client";

import { Images, LoaderCircle, MessageSquarePlus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getImageConversationStats, type ImageConversation } from "@/store/image-conversations";

type ImageSidebarProps = {
  conversations: ImageConversation[];
  isLoadingHistory: boolean;
  selectedConversationId: string | null;
  onCreateDraft: () => void;
  onClearHistory: () => void | Promise<void>;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
  hideActionButtons?: boolean;
};

export function ImageSidebar({
  conversations,
  isLoadingHistory,
  selectedConversationId,
  onCreateDraft,
  onClearHistory,
  onSelectConversation,
  onDeleteConversation,
  formatConversationTime,
  hideActionButtons = false,
}: ImageSidebarProps) {
  return (
    <aside className="h-full min-h-0 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col gap-3 py-1 sm:py-2">
        {!hideActionButtons && (
          <div className="space-y-3 rounded-2xl border border-stone-200/70 bg-white/80 p-3 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-stone-950 text-white">
                  <Images className="size-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-stone-950">历史记录</div>
                  <div className="text-xs text-stone-500">{conversations.length} 条对话</div>
                </div>
              </div>
              <Button
                variant="outline"
                className="size-8 rounded-xl border-stone-200 bg-white px-0 text-stone-500 hover:bg-stone-50 hover:text-rose-500"
                onClick={() => void onClearHistory()}
                disabled={conversations.length === 0}
                aria-label="清空历史"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <Button className="h-10 w-full rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={onCreateDraft}>
              <MessageSquarePlus className="size-4" />
              新建对话
            </Button>
          </div>
        )}

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto [scrollbar-color:rgba(120,113,108,.45)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-400/45 [&::-webkit-scrollbar-track]:bg-transparent",
            hideActionButtons ? "space-y-1 pr-0" : "space-y-2 pr-1",
          )}
        >
          {isLoadingHistory ? (
            <div className="flex items-center gap-2 rounded-2xl border border-stone-200 bg-white/70 px-3 py-3 text-sm text-stone-500">
              <LoaderCircle className="size-4 animate-spin" />
              正在读取会话记录
            </div>
          ) : conversations.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-stone-200 bg-white/55 px-4 py-5 text-sm leading-6 text-stone-500">
              还没有图片记录，输入提示词后会在这里显示。
            </div>
          ) : (
            conversations.map((conversation) => {
              const active = conversation.id === selectedConversationId;
              const stats = getImageConversationStats(conversation);
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    "group relative w-full text-left transition",
                    hideActionButtons
                      ? "rounded-2xl border border-transparent px-4 py-3.5"
                      : "rounded-2xl border px-3 py-2 shadow-sm sm:py-3",
                    active
                      ? "border-stone-300 bg-white text-stone-950 shadow-[0_14px_38px_-30px_rgba(28,25,23,0.45)]"
                      : "border-stone-200/60 bg-white/55 text-stone-700 hover:border-stone-300 hover:bg-white",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    className="block w-full pr-9 text-left"
                  >
                    <div className={cn("truncate font-semibold", hideActionButtons ? "text-base" : "text-sm")}>
                      <span className="truncate">{conversation.title}</span>
                    </div>
                    <div className={cn("mt-1 text-xs", active ? "text-stone-500" : "text-stone-400")}>
                      {conversation.turns.length} 轮 · {formatConversationTime(conversation.updatedAt)}
                    </div>
                    {stats.running > 0 || stats.queued > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                        {stats.running > 0 ? (
                          <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-600">处理中 {stats.running}</span>
                        ) : null}
                        {stats.queued > 0 ? (
                          <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">排队 {stats.queued}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDeleteConversation(conversation.id);
                    }}
                    className={cn(
                      "absolute right-2 top-3 inline-flex size-7 items-center justify-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-rose-500",
                      hideActionButtons ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                    aria-label="删除会话"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
