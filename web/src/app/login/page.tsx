"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, LoaderCircle, LockKeyhole } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { login } from "@/lib/api";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const handleLogin = async () => {
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      toast.error("请输入用户名和密码");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await login("", { username: normalizedUsername, password });
      const token = String(data.token || "").trim();
      if (!token) {
        throw new Error("登录成功但没有返回登录凭证");
      }
      await setStoredAuthSession({
        key: token,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name || normalizedUsername,
      });
      toast.success("已登录，本设备会使用当前用户额度");
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="grid min-h-[100dvh] w-full place-items-center px-4 py-6">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] w-full items-start justify-center overflow-y-auto bg-stone-50 px-4 py-5 sm:items-center sm:py-8">
      <Card className="w-full max-w-[430px] rounded-[20px] border-stone-200/80 bg-white shadow-[0_18px_60px_rgba(28,25,23,0.10)]">
        <CardContent className="space-y-5 p-5 sm:space-y-6 sm:p-7">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-stone-500 transition hover:bg-stone-100 hover:text-stone-950"
              aria-label="返回"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
              登录用户 20 张
            </span>
          </div>

          <div className="space-y-3 text-center">
            <div className="mx-auto inline-flex size-12 items-center justify-center rounded-[16px] bg-stone-950 text-white shadow-sm">
              <LockKeyhole className="size-5" />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight text-stone-950">登录后生成更多图片</h1>
              <p className="text-sm leading-6 text-stone-500">访客可生成 5 张，登录后当前设备使用你的 20 张额度。</p>
            </div>
          </div>

          <div className="space-y-2.5">
            <label htmlFor="username" className="block text-sm font-medium text-stone-700">
              用户名
            </label>
            <Input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleLogin();
                }
              }}
              placeholder="自定义用户名"
              className="h-12 rounded-2xl border-stone-200 bg-white px-4 text-[15px]"
              autoComplete="username"
            />
          </div>

          <div className="space-y-2.5">
            <label htmlFor="password" className="block text-sm font-medium text-stone-700">
              密码
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleLogin();
                }
              }}
              placeholder="自定义密码"
              className="h-12 rounded-2xl border-stone-200 bg-white px-4 text-[15px]"
              autoComplete="current-password"
            />
          </div>

          <Button
            className="h-12 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
            onClick={() => void handleLogin()}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            登录
          </Button>

          <Link
            href="/"
            className="block text-center text-sm font-medium text-stone-500 transition hover:text-stone-950"
          >
            继续以访客身份使用
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
