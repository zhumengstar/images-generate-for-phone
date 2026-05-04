"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderCircle, RefreshCw, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchWebUsers, type WebUser } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

function formatTime(value: string | null) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function roleLabel(role: WebUser["role"]) {
  return role === "admin" ? "管理员" : "普通用户";
}

function formatUserQuota(user: WebUser) {
  return user.quota_limit < 0 ? "不限" : `${user.used_total}/${user.quota_limit}`;
}

export default function UsersPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  const [users, setUsers] = useState<WebUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchWebUsers();
      setUsers(data.items);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取用户失败";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isCheckingAuth || !session || session.role !== "admin") {
      return;
    }
    void loadUsers();
  }, [isCheckingAuth, loadUsers, session]);

  const stats = useMemo(
    () => ({
      total: users.length,
      admins: users.filter((user) => user.role === "admin").length,
      active: users.reduce((sum, user) => sum + Math.max(0, user.device_count), 0),
      used: users.reduce((sum, user) => sum + Math.max(0, user.used_total), 0),
    }),
    [users],
  );

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-stone-50 px-3 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-950">用户管理</h1>
            <p className="mt-1 text-sm text-stone-500">查看后台保存的登录用户、角色、设备会话和图片使用情况。</p>
          </div>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-stone-200 bg-white"
            onClick={() => void loadUsers()}
            disabled={isLoading}
          >
            {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ["用户总数", stats.total],
            ["管理员", stats.admins],
            ["占用设备", stats.active],
            ["总使用张数", stats.used],
          ].map(([label, value]) => (
            <Card key={label} className="rounded-2xl border-stone-200/80 bg-white shadow-sm">
              <CardContent className="p-4">
                <div className="text-xs font-medium text-stone-500">{label}</div>
                <div className="mt-2 text-2xl font-semibold text-stone-950">{value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="overflow-hidden rounded-2xl border-stone-200/80 bg-white shadow-sm">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex h-40 items-center justify-center">
                <LoaderCircle className="size-5 animate-spin text-stone-400" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse text-left text-sm">
                  <thead className="border-b border-stone-100 bg-stone-50 text-xs font-semibold text-stone-500">
                    <tr>
                      <th className="px-4 py-3">用户</th>
                      <th className="px-4 py-3">角色</th>
                      <th className="px-4 py-3">密码</th>
                      <th className="px-4 py-3">会话</th>
                      <th className="px-4 py-3">使用情况</th>
                      <th className="px-4 py-3">最后登录</th>
                      <th className="px-4 py-3">创建时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {users.map((user) => (
                      <tr key={user.id} className="align-top">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="inline-flex size-8 items-center justify-center rounded-full bg-stone-100 text-stone-500">
                              {user.role === "admin" ? <ShieldCheck className="size-4" /> : <UserRound className="size-4" />}
                            </div>
                            <div className="min-w-0">
                              <div className="font-semibold text-stone-950">{user.username || user.name}</div>
                              <div className="font-mono text-xs text-stone-400">{user.id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold",
                              user.role === "admin" ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-600",
                            )}
                          >
                            {roleLabel(user.role)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-stone-600">{user.password_saved ? "已保存" : "未保存"}</td>
                        <td className="px-4 py-3 text-stone-600">
                          {user.role === "admin"
                            ? `${user.active_sessions} 个管理员会话`
                            : `${user.active_sessions} 个登录会话 / ${user.device_count} 台设备`}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-stone-950">
                            {formatUserQuota(user)}
                          </div>
                          <div className="mt-1 max-w-[260px] text-xs leading-5 text-stone-500">
                            {user.quota_limit < 0
                              ? "管理员生成图片不受额度限制"
                              : user.device_usages.length > 0
                              ? user.device_usages
                                  .slice(0, 2)
                                  .map((usage) => `${usage.device.slice(0, 10)}: ${usage.used} 张`)
                                  .join("，")
                              : "暂无生成记录"}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-stone-600">{formatTime(user.last_used_at)}</td>
                        <td className="px-4 py-3 text-stone-600">{formatTime(user.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {users.length === 0 ? (
                  <div className="p-8 text-center text-sm text-stone-500">暂无用户</div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
