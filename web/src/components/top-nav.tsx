"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Github, LogIn, LogOut, UserRound } from "lucide-react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";

import webConfig from "@/constants/common-env";
import { clearStoredAuthSession, getStoredAuthSession, type StoredAuthSession } from "@/store/auth";
import { cn } from "@/lib/utils";

const adminNavItems = [
  { href: "/", label: "图片生成" },
  { href: "/users", label: "用户管理" },
];
const userNavItems = [{ href: "/", label: "图片生成" }];
type ImageMode = "generate" | "edit";

const anonymousImageSession: StoredAuthSession = {
  key: "",
  role: "user",
  subjectId: "anonymous-user",
  name: "访客",
  isGuest: true,
};

export function TopNav() {
  const pathname = usePathname();
  const isImagePagePath = pathname === "/" || pathname === "/image" || pathname.startsWith("/image/");
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(
    isImagePagePath ? anonymousImageSession : undefined,
  );
  const [imageMode, setImageMode] = useState<ImageMode>("generate");

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (active) setSession(null);
        return;
      }

      const storedSession = await getStoredAuthSession().catch(() => null);
      if (!active) {
        return;
      }
      setSession(storedSession || (isImagePagePath ? anonymousImageSession : null));
    };

    void load();
    return () => {
      active = false;
    };
  }, [isImagePagePath, pathname]);

  useEffect(() => {
    if (!isImagePagePath || typeof window === "undefined") {
      return;
    }

    const handleModeChange = (event: Event) => {
      const mode = (event as CustomEvent<ImageMode>).detail;
      if (mode === "generate" || mode === "edit") {
        setImageMode(mode);
      }
    };

    window.addEventListener("image-mode-changed", handleModeChange);
    return () => {
      window.removeEventListener("image-mode-changed", handleModeChange);
    };
  }, [isImagePagePath]);

  const requestImageMode = (mode: ImageMode) => {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent("image-mode-request", { detail: mode }));
  };

  const handleLogout = async () => {
    await clearStoredAuthSession();
    toast.success("已退出，当前设备切换为访客");
    window.location.replace("/");
  };

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const isGuest = Boolean(session.isGuest) || !session.key;
  const roleLabel = session.role === "admin" ? "管理员" : isGuest ? "访客" : session.name || "普通用户";

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 shrink-0 touch-none select-none overscroll-contain border-b border-stone-200/70 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/88 sm:relative sm:inset-auto sm:z-auto sm:touch-auto sm:bg-white/75 sm:shadow-none">
        <div className="mx-auto grid min-h-12 max-w-[1440px] grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 sm:flex sm:min-h-12 sm:gap-3 sm:px-6 sm:py-1">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Link
            href="/"
            className="min-w-0 shrink truncate py-1 text-[15px] font-bold tracking-tight text-stone-950 transition hover:text-stone-700 sm:shrink-0"
          >
            images-generate
          </Link>
          <a
            href="https://github.com/zhumengstar/images-generate-for-phone"
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 py-1 text-sm text-stone-400 transition hover:text-stone-700 sm:inline-flex"
            aria-label="GitHub repository"
          >
            <Github className="size-4" />
            <span className="hidden md:inline">GitHub</span>
          </a>
        </div>
        {isImagePagePath ? (
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
            <div className="grid grid-cols-2 gap-1 rounded-full bg-stone-100 p-1">
              <button
                type="button"
                className={cn(
                  "h-8 rounded-full px-2.5 text-[12px] font-extrabold transition sm:px-4 sm:text-sm",
                  imageMode === "generate" ? "bg-stone-950 text-white shadow-sm" : "text-stone-500 hover:bg-white",
                )}
                onClick={() => requestImageMode("generate")}
                aria-pressed={imageMode === "generate"}
              >
                文生图
              </button>
              <button
                type="button"
                className={cn(
                  "h-8 rounded-full px-2.5 text-[12px] font-extrabold transition sm:px-4 sm:text-sm",
                  imageMode === "edit" ? "bg-stone-950 text-white shadow-sm" : "cursor-default text-stone-500",
                )}
                onClick={(event) => event.preventDefault()}
                aria-pressed={imageMode === "edit"}
                tabIndex={-1}
              >
                图片编辑
              </button>
            </div>
            {!isGuest && session.role === "admin" ? (
              <Link
                href="/users"
                className="hidden h-9 items-center rounded-full border border-stone-200 bg-white px-3 text-xs font-bold text-stone-700 shadow-sm transition hover:bg-stone-50 hover:text-stone-950 sm:inline-flex"
              >
                用户
              </Link>
            ) : null}
            {isGuest ? (
              <Link
                href="/login"
                className="inline-flex h-9 items-center gap-1 rounded-full bg-stone-950 px-3 text-[12px] font-bold text-white shadow-sm transition hover:bg-stone-800 sm:px-4 sm:text-sm"
                aria-label="登录"
              >
                <LogIn className="size-3.5" />
                登录
              </Link>
            ) : (
              <div className="flex h-9 items-center gap-1 rounded-full border border-stone-200 bg-white px-1.5 shadow-sm">
                <span className="hidden max-w-[120px] items-center gap-1.5 truncate px-2 text-xs font-semibold text-stone-700 sm:inline-flex">
                  <UserRound className="size-3.5 shrink-0 text-stone-400" />
                  <span className="truncate">{roleLabel}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="inline-flex size-7 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 hover:text-stone-950"
                  aria-label="退出登录"
                  title="退出登录"
                >
                  <LogOut className="size-4" />
                </button>
              </div>
            )}
          </div>
        ) : (
          <nav className="hide-scrollbar flex min-w-0 flex-1 justify-end gap-1 overflow-x-auto sm:mx-0 sm:justify-center sm:gap-8 sm:overflow-visible sm:px-0">
            {navItems.map((item) => {
              const active = pathname === item.href || (pathname.startsWith("/image") && item.href === "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "relative shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium transition sm:rounded-none sm:px-0 sm:text-[15px]",
                    active
                      ? "bg-stone-950 text-white sm:bg-transparent sm:font-semibold sm:text-stone-950"
                      : "text-stone-500 hover:text-stone-900",
                  )}
                >
                  {item.label}
                  {active ? <span className="absolute inset-x-0 -bottom-[1px] hidden h-0.5 bg-stone-950 sm:block" /> : null}
                </Link>
              );
            })}
          </nav>
        )}
        <div className="hidden items-center justify-end gap-2 sm:flex sm:gap-3">
          <span className="hidden rounded-md bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-500 sm:inline-block sm:text-[11px]">
            {roleLabel}
          </span>
          <span className="hidden rounded-md bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-500 sm:inline-block sm:text-[11px]">
            v{webConfig.appVersion}
          </span>
        </div>
        </div>
      </header>
      <div className="h-12 shrink-0 sm:hidden" aria-hidden="true" />
    </>
  );
}
