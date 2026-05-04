"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Github } from "lucide-react";
import { usePathname } from "next/navigation";

import webConfig from "@/constants/common-env";
import { getStoredAuthSession, type StoredAuthSession } from "@/store/auth";
import { cn } from "@/lib/utils";

const adminNavItems = [
  { href: "/", label: "图片生成" },
];

const userNavItems = [{ href: "/", label: "图片生成" }];
type ImageMode = "generate" | "edit";

export function TopNav() {
  const pathname = usePathname();
  const anonymousImageSession: StoredAuthSession = {
    key: "",
    role: "user",
    subjectId: "anonymous-user",
    name: "普通用户",
  };
  const isImagePagePath = pathname === "/" || pathname === "/image" || pathname.startsWith("/image/");
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(
    isImagePagePath ? anonymousImageSession : undefined,
  );
  const [imageMode, setImageMode] = useState<ImageMode>("generate");

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
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

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";

  return (
    <header className="shrink-0 border-b border-stone-100/70 bg-white/90 backdrop-blur sm:bg-transparent">
      <div className="flex h-12 items-center justify-between gap-2 px-3 sm:h-12 sm:gap-3 sm:px-6">
        <div className="flex min-w-0 items-center justify-between gap-2 sm:justify-start sm:gap-3">
          <Link
            href="/"
            className="min-w-0 shrink py-1 text-[15px] font-bold tracking-tight text-stone-950 transition hover:text-stone-700 sm:shrink-0"
          >
            images-generate
          </Link>
          <a
            href="https://github.com/zhumengstar/images-generate-for-phone"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 py-1 text-sm text-stone-400 transition hover:text-stone-700"
            aria-label="GitHub repository"
          >
            <Github className="size-4" />
            <span className="hidden md:inline">GitHub</span>
          </a>
        </div>
        {isImagePagePath ? (
          <div className="ml-auto grid shrink-0 grid-cols-2 gap-1 rounded-full bg-stone-100 p-1">
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
                imageMode === "edit" ? "bg-stone-950 text-white shadow-sm" : "text-stone-500 hover:bg-white",
              )}
              onClick={() => requestImageMode("edit")}
              aria-pressed={imageMode === "edit"}
            >
              图片编辑
            </button>
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
  );
}
