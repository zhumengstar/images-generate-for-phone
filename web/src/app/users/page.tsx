"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Infinity, LoaderCircle, RefreshCw, Save, Search, ShieldCheck, UserRound, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchWebUsers, updateWebUserQuota, type WebUser } from "@/lib/api";
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
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function roleLabel(role: WebUser["role"]) {
  if (role === "admin") {
    return "管理员";
  }
  return role === "guest" ? "访客" : "用户";
}

function formatUserQuota(user: WebUser) {
  return user.quota_limit < 0 ? "不限" : `${user.remaining_total}/${user.quota_limit}`;
}

function formatSession(user: WebUser) {
  if (user.role === "admin") {
    return `${user.active_sessions} 会话`;
  }
  if (user.role === "guest") {
    return `${user.device_count} 设备`;
  }
  return `${user.active_sessions} 会话 / ${user.device_count} 设备`;
}

type RoleFilter = "all" | WebUser["role"];
type QuotaFilter = "all" | "limited" | "unlimited" | "used";

export default function UsersPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  const [users, setUsers] = useState<WebUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [quotaFilter, setQuotaFilter] = useState<QuotaFilter>("all");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [bulkQuotaDraft, setBulkQuotaDraft] = useState("");
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [savingQuotaIds, setSavingQuotaIds] = useState<Record<string, boolean>>({});

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchWebUsers();
      const items = Array.isArray(data.items) ? data.items : [];
      if (!Array.isArray(data.items)) {
        toast.error("读取用户失败，请重新登录后再试");
      }
      setUsers(items);
      setQuotaDrafts(
        Object.fromEntries(items.map((user) => [user.id, user.quota_limit < 0 ? "" : String(user.quota_limit)])),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取用户失败";
      setUsers([]);
      setQuotaDrafts({});
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const saveUserQuota = useCallback(async (user: WebUser, quotaLimit: number) => {
    setSavingQuotaIds((current) => ({ ...current, [user.id]: true }));
    try {
      const data = await updateWebUserQuota(user.id, quotaLimit);
      const items = Array.isArray(data.items) ? data.items : [];
      setUsers(items);
      setQuotaDrafts(
        Object.fromEntries(items.map((item) => [item.id, item.quota_limit < 0 ? "" : String(item.quota_limit)])),
      );
      toast.success(quotaLimit < 0 ? "已设置为无限额度" : "图片额度已保存");
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存图片额度失败";
      toast.error(message);
    } finally {
      setSavingQuotaIds((current) => ({ ...current, [user.id]: false }));
    }
  }, []);

  const saveFiniteQuota = useCallback(
    async (user: WebUser) => {
      const value = quotaDrafts[user.id]?.trim() ?? "";
      if (!/^\d+$/.test(value)) {
        toast.error("请输入 0 或更大的整数张数");
        return;
      }
      await saveUserQuota(user, Number(value));
    },
    [quotaDrafts, saveUserQuota],
  );

  const clearSelectedUsers = useCallback(() => {
    setSelectedUserIds([]);
  }, []);

  useEffect(() => {
    if (isCheckingAuth || !session || session.role !== "admin") {
      return;
    }
    void loadUsers();
  }, [isCheckingAuth, loadUsers, session]);

  useEffect(() => {
    const updateViewportHeight = () => {
      setViewportHeight(window.innerHeight || 0);
    };
    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => {
      window.removeEventListener("resize", updateViewportHeight);
    };
  }, []);

  useEffect(() => {
    const existingIds = new Set(users.map((user) => user.id));
    setSelectedUserIds((current) => current.filter((id) => existingIds.has(id)));
  }, [users]);

  const stats = useMemo(
    () => ({
      total: users.length,
      admins: users.filter((user) => user.role === "admin").length,
      active: users.reduce((sum, user) => sum + Math.max(0, user.device_count), 0),
      used: users.reduce((sum, user) => sum + Math.max(0, user.used_total), 0),
    }),
    [users],
  );

  const filteredUsers = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return users.filter((user) => {
      const matchesSearch =
        !query ||
        [user.username, user.name, user.id, user.role]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      const matchesRole = roleFilter === "all" || user.role === roleFilter;
      const matchesQuota =
        quotaFilter === "all" ||
        (quotaFilter === "limited" && user.quota_limit >= 0) ||
        (quotaFilter === "unlimited" && user.quota_limit < 0) ||
        (quotaFilter === "used" && user.used_total > 0);
      return matchesSearch && matchesRole && matchesQuota;
    });
  }, [quotaFilter, roleFilter, searchText, users]);

  const selectableFilteredUsers = useMemo(
    () => filteredUsers.filter((user) => user.role !== "admin"),
    [filteredUsers],
  );

  const selectedUsers = useMemo(
    () => users.filter((user) => user.role !== "admin" && selectedUserIds.includes(user.id)),
    [selectedUserIds, users],
  );

  const allVisibleSelected =
    selectableFilteredUsers.length > 0 && selectableFilteredUsers.every((user) => selectedUserIds.includes(user.id));

  const toggleUserSelected = (user: WebUser) => {
    if (user.role === "admin") {
      return;
    }
    setSelectedUserIds((current) =>
      current.includes(user.id) ? current.filter((id) => id !== user.id) : [...current, user.id],
    );
  };

  const toggleVisibleSelected = () => {
    const visibleIds = selectableFilteredUsers.map((user) => user.id);
    if (visibleIds.length === 0) {
      return;
    }
    setSelectedUserIds((current) => {
      if (visibleIds.every((id) => current.includes(id))) {
        return current.filter((id) => !visibleIds.includes(id));
      }
      return Array.from(new Set([...current, ...visibleIds]));
    });
  };

  const saveBulkQuota = useCallback(
    async (quotaLimit: number) => {
      if (selectedUsers.length === 0 || isBulkSaving) {
        return;
      }
      setIsBulkSaving(true);
      setSavingQuotaIds((current) => ({
        ...current,
        ...Object.fromEntries(selectedUsers.map((user) => [user.id, true])),
      }));
      try {
        let latestItems: WebUser[] | null = null;
        for (const user of selectedUsers) {
          const data = await updateWebUserQuota(user.id, quotaLimit);
          latestItems = Array.isArray(data.items) ? data.items : latestItems;
        }
        if (latestItems) {
          setUsers(latestItems);
          setQuotaDrafts(
            Object.fromEntries(latestItems.map((item) => [item.id, item.quota_limit < 0 ? "" : String(item.quota_limit)])),
          );
        } else {
          await loadUsers();
        }
        toast.success(`已批量更新 ${selectedUsers.length} 个用户`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "批量更新失败";
        toast.error(message);
        await loadUsers();
      } finally {
        setSavingQuotaIds((current) => ({
          ...current,
          ...Object.fromEntries(selectedUsers.map((user) => [user.id, false])),
        }));
        setIsBulkSaving(false);
      }
    },
    [isBulkSaving, loadUsers, selectedUsers],
  );

  const saveBulkFiniteQuota = useCallback(async () => {
    const value = bulkQuotaDraft.trim();
    if (!/^\d+$/.test(value)) {
      toast.error("请输入 0 或更大的整数张数");
      return;
    }
    await saveBulkQuota(Number(value));
  }, [bulkQuotaDraft, saveBulkQuota]);

  const resetFilters = () => {
    setSearchText("");
    setRoleFilter("all");
    setQuotaFilter("all");
  };

  const hasFilters = Boolean(searchText.trim()) || roleFilter !== "all" || quotaFilter !== "all";
  const hasSelectedUsers = selectedUsers.length > 0;

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <main
      className="flex min-h-0 shrink-0 overflow-hidden bg-stone-50 px-3 py-4 sm:px-6 sm:py-5 lg:-mx-8 lg:px-4 xl:px-5"
      style={{
        height: viewportHeight ? `${Math.max(520, viewportHeight - 104)}px` : "796px",
        maxHeight: viewportHeight ? `${Math.max(520, viewportHeight - 104)}px` : "796px",
        minHeight: 0,
      }}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-none flex-col gap-4">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-950">用户管理</h1>
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

        <div className="grid shrink-0 gap-3 sm:grid-cols-4">
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

        <Card className="flex min-h-0 flex-1 overflow-hidden rounded-2xl border-stone-200/80 bg-white shadow-sm">
          <CardContent className="flex min-h-0 w-full flex-1 flex-col p-0">
            <div className="shrink-0 border-b border-stone-100 bg-white p-3 sm:p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative w-full xl:max-w-[380px]">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    className="h-10 rounded-xl border-stone-200 bg-white pl-10 pr-10 text-sm"
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder="搜索用户名、角色或 ID"
                  />
                  {searchText ? (
                    <button
                      type="button"
                      className="absolute right-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
                      onClick={() => setSearchText("")}
                      aria-label="清空搜索"
                    >
                      <X className="size-4" />
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {[
                    ["all", "全部角色"],
                    ["admin", "管理员"],
                    ["user", "用户"],
                    ["guest", "访客"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "h-9 rounded-xl border px-3 text-sm font-medium transition",
                        roleFilter === value
                          ? "border-stone-950 bg-stone-950 text-white"
                          : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50 hover:text-stone-950",
                      )}
                      onClick={() => setRoleFilter(value as RoleFilter)}
                    >
                      {label}
                    </button>
                  ))}
                  {[
                    ["all", "全部额度"],
                    ["limited", "有限额度"],
                    ["unlimited", "无限额度"],
                    ["used", "已使用"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "h-9 rounded-xl border px-3 text-sm font-medium transition",
                        quotaFilter === value
                          ? "border-stone-950 bg-stone-950 text-white"
                          : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50 hover:text-stone-950",
                      )}
                      onClick={() => setQuotaFilter(value as QuotaFilter)}
                    >
                      {label}
                    </button>
                  ))}
                  {hasFilters ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-9 rounded-xl px-3 text-stone-600"
                      onClick={resetFilters}
                    >
                      <X className="size-4" />
                      重置
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="mt-3 text-xs font-medium text-stone-500">
                显示 {filteredUsers.length} / {users.length} 个用户
              </div>
            </div>
            {isLoading ? (
              <div className="flex h-40 items-center justify-center">
                <LoaderCircle className="size-5 animate-spin text-stone-400" />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
                  <thead className="sticky top-0 z-10 border-b border-stone-100 bg-stone-50 text-xs font-semibold text-stone-500">
                    <tr>
                      <th className="whitespace-nowrap px-5 py-3">用户</th>
                      <th className="whitespace-nowrap px-5 py-3">角色</th>
                      <th className="whitespace-nowrap px-5 py-3">会话</th>
                      <th className="whitespace-nowrap px-5 py-3">可用额度</th>
                      <th className="whitespace-nowrap px-5 py-3">图片额度</th>
                      <th className="whitespace-nowrap px-5 py-3">最后登录</th>
                      <th className="whitespace-nowrap px-5 py-3">创建时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="align-top">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div className="inline-flex size-8 items-center justify-center rounded-full bg-stone-100 text-stone-500">
                              {user.role === "admin" ? <ShieldCheck className="size-4" /> : <UserRound className="size-4" />}
                            </div>
                            <div className="min-w-0">
                              <div className="whitespace-nowrap font-semibold text-stone-950">{user.username || user.name}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={cn(
                              "inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold",
                              user.role === "admin" ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-600",
                            )}
                          >
                            {roleLabel(user.role)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-stone-600">
                          {formatSession(user)}
                        </td>
                        <td className="px-5 py-3">
                          <div className="whitespace-nowrap font-semibold text-stone-950">
                            {formatUserQuota(user)}
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          {user.role === "admin" ? (
                            <span className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-stone-100 px-3 text-xs font-semibold text-stone-600">
                              <Infinity className="size-4" />
                              无限
                            </span>
                          ) : (
                            <div className="flex min-w-[250px] items-center gap-2 whitespace-nowrap">
                              <Input
                                className="h-9 w-28 rounded-xl border-stone-200 bg-white text-sm"
                                inputMode="numeric"
                                min={0}
                                type="number"
                                value={quotaDrafts[user.id] ?? ""}
                                placeholder="无限"
                                disabled={Boolean(savingQuotaIds[user.id])}
                                onChange={(event) =>
                                  setQuotaDrafts((current) => ({ ...current, [user.id]: event.target.value }))
                                }
                              />
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-9 whitespace-nowrap rounded-xl border-stone-200 bg-white px-3"
                                disabled={Boolean(savingQuotaIds[user.id])}
                                onClick={() => void saveFiniteQuota(user)}
                              >
                                {savingQuotaIds[user.id] ? (
                                  <LoaderCircle className="size-4 animate-spin" />
                                ) : (
                                  <Save className="size-4" />
                                )}
                                保存
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 whitespace-nowrap rounded-xl px-3 text-stone-600"
                                disabled={Boolean(savingQuotaIds[user.id])}
                                onClick={() => void saveUserQuota(user, -1)}
                              >
                                <Infinity className="size-4" />
                                无限
                              </Button>
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-stone-600">{formatTime(user.last_used_at)}</td>
                        <td className="whitespace-nowrap px-5 py-3 text-stone-600">{formatTime(user.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredUsers.length === 0 ? (
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
