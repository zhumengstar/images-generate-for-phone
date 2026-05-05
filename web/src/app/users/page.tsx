"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Infinity, LoaderCircle, RefreshCw, Save, Search, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  deleteWebUser,
  fetchWebUsers,
  updateWebUserDefaultQuotas,
  updateWebUserQuota,
  type WebUser,
  type WebUsersResponse,
} from "@/lib/api";
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
type UsedSort = "none" | "desc" | "asc";

export default function UsersPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  const [users, setUsers] = useState<WebUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [quotaFilter, setQuotaFilter] = useState<QuotaFilter>("all");
  const [usedSort, setUsedSort] = useState<UsedSort>("none");
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [bulkQuotaDraft, setBulkQuotaDraft] = useState("");
  const [isBulkSaving, setIsBulkSaving] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [savingQuotaIds, setSavingQuotaIds] = useState<Record<string, boolean>>({});
  const [deletingUserIds, setDeletingUserIds] = useState<Record<string, boolean>>({});
  const [defaultQuotaDrafts, setDefaultQuotaDrafts] = useState({
    user_image_quota_limit: "20",
    guest_image_quota_limit: "5",
  });
  const [isSavingDefaultQuotas, setIsSavingDefaultQuotas] = useState(false);

  const applyWebUsersData = useCallback((data: WebUsersResponse) => {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!Array.isArray(data.items)) {
      toast.error("读取用户失败，请重新登录后再试");
    }
    setUsers(items);
    setQuotaDrafts(
      Object.fromEntries(items.map((user) => [user.id, user.quota_limit < 0 ? "" : String(user.quota_limit)])),
    );
    const limits = data.default_quota_limits;
    if (limits) {
      setDefaultQuotaDrafts({
        user_image_quota_limit: String(Math.max(0, Number(limits.user_image_quota_limit) || 0)),
        guest_image_quota_limit: String(Math.max(0, Number(limits.guest_image_quota_limit) || 0)),
      });
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await fetchWebUsers();
      applyWebUsersData(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取用户失败";
      setUsers([]);
      setQuotaDrafts({});
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [applyWebUsersData]);

  const saveUserQuota = useCallback(async (user: WebUser, quotaLimit: number) => {
    setSavingQuotaIds((current) => ({ ...current, [user.id]: true }));
    try {
      const data = await updateWebUserQuota(user.id, quotaLimit);
      applyWebUsersData(data);
      toast.success(quotaLimit < 0 ? "已设置为无限额度" : "图片额度已保存");
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存图片额度失败";
      toast.error(message);
    } finally {
      setSavingQuotaIds((current) => ({ ...current, [user.id]: false }));
    }
  }, [applyWebUsersData]);

  const saveDefaultQuotas = useCallback(async () => {
    const userLimit = defaultQuotaDrafts.user_image_quota_limit.trim();
    const guestLimit = defaultQuotaDrafts.guest_image_quota_limit.trim();
    if (!/^\d+$/.test(userLimit) || !/^\d+$/.test(guestLimit)) {
      toast.error("默认额度请输入 0 或更大的整数");
      return;
    }
    setIsSavingDefaultQuotas(true);
    try {
      const data = await updateWebUserDefaultQuotas({
        user_image_quota_limit: Number(userLimit),
        guest_image_quota_limit: Number(guestLimit),
      });
      applyWebUsersData(data);
      toast.success("默认额度已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存默认额度失败");
    } finally {
      setIsSavingDefaultQuotas(false);
    }
  }, [applyWebUsersData, defaultQuotaDrafts]);

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

  const deleteUser = useCallback(async (user: WebUser) => {
    if (user.role === "admin" || deletingUserIds[user.id] || isBulkDeleting) {
      return;
    }
    const displayName = user.username || user.name || user.id;
    if (!window.confirm(`确认删除用户「${displayName}」？删除后会清空该用户的额度记录。`)) {
      return;
    }
    setDeletingUserIds((current) => ({ ...current, [user.id]: true }));
    try {
      const data = await deleteWebUser(user.id);
      applyWebUsersData(data);
      setSelectedUserIds((current) => current.filter((id) => id !== user.id));
      toast.success("用户已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除用户失败");
    } finally {
      setDeletingUserIds((current) => ({ ...current, [user.id]: false }));
    }
  }, [applyWebUsersData, deletingUserIds, isBulkDeleting]);

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

  const displayedUsers = useMemo(() => {
    if (usedSort === "none") {
      return filteredUsers;
    }
    return [...filteredUsers].sort((left, right) => {
      const diff = Math.max(0, left.used_total) - Math.max(0, right.used_total);
      if (diff !== 0) {
        return usedSort === "asc" ? diff : -diff;
      }
      return String(left.username || left.name || left.id).localeCompare(String(right.username || right.name || right.id));
    });
  }, [filteredUsers, usedSort]);

  const selectableFilteredUsers = useMemo(
    () => displayedUsers.filter((user) => user.role !== "admin"),
    [displayedUsers],
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

  const toggleUsedSort = () => {
    setUsedSort((current) => (current === "none" ? "desc" : current === "desc" ? "asc" : "none"));
  };

  const deleteSelectedUsers = useCallback(async () => {
    if (selectedUsers.length === 0 || isBulkSaving || isBulkDeleting) {
      return;
    }
    if (!window.confirm(`确认删除已选的 ${selectedUsers.length} 个用户？删除后会清空这些用户的额度记录。`)) {
      return;
    }
    setIsBulkDeleting(true);
    setDeletingUserIds((current) => ({
      ...current,
      ...Object.fromEntries(selectedUsers.map((user) => [user.id, true])),
    }));
    try {
      let latestData: WebUsersResponse | null = null;
      for (const user of selectedUsers) {
        latestData = await deleteWebUser(user.id);
      }
      if (latestData) {
        applyWebUsersData(latestData);
      } else {
        await loadUsers();
      }
      setSelectedUserIds([]);
      toast.success(`已批量删除 ${selectedUsers.length} 个用户`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "批量删除失败");
      await loadUsers();
    } finally {
      setDeletingUserIds((current) => ({
        ...current,
        ...Object.fromEntries(selectedUsers.map((user) => [user.id, false])),
      }));
      setIsBulkDeleting(false);
    }
  }, [applyWebUsersData, isBulkDeleting, isBulkSaving, loadUsers, selectedUsers]);

  const saveBulkQuota = useCallback(
    async (quotaLimit: number) => {
      if (selectedUsers.length === 0 || isBulkSaving || isBulkDeleting) {
        return;
      }
      setIsBulkSaving(true);
      setSavingQuotaIds((current) => ({
        ...current,
        ...Object.fromEntries(selectedUsers.map((user) => [user.id, true])),
      }));
      try {
        let latestData: WebUsersResponse | null = null;
        for (const user of selectedUsers) {
          const data = await updateWebUserQuota(user.id, quotaLimit);
          latestData = data;
        }
        if (latestData) {
          applyWebUsersData(latestData);
        } else {
          await loadUsers();
        }
        setSelectedUserIds([]);
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
    [applyWebUsersData, isBulkDeleting, isBulkSaving, loadUsers, selectedUsers],
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
  const isBulkBusy = isBulkSaving || isBulkDeleting;

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <main
      className="flex min-h-0 shrink-0 overflow-hidden bg-stone-50 px-3 py-2 sm:px-6 sm:py-2 lg:-mx-8 lg:px-4 xl:px-5"
      style={{
        height: viewportHeight ? `${Math.max(520, viewportHeight - 104)}px` : "796px",
        maxHeight: viewportHeight ? `${Math.max(520, viewportHeight - 104)}px` : "796px",
        minHeight: 0,
      }}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-none flex-col gap-2">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-stone-950">用户管理</h1>
            {[
              ["用户", stats.total],
              ["管理员", stats.admins],
              ["设备", stats.active],
              ["用图", stats.used],
            ].map(([label, value]) => (
              <span
                key={label}
                className="inline-flex h-8 items-center gap-1 rounded-full border border-stone-200 bg-white px-3 text-xs font-medium text-stone-500 shadow-sm"
              >
                {label}
                <span className="text-sm font-semibold text-stone-950">{value}</span>
              </span>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="hidden shrink-0 items-center gap-2 rounded-2xl border border-stone-200/80 bg-white px-3 py-1.5 shadow-sm md:flex">
              <span className="whitespace-nowrap text-sm font-semibold text-stone-800">默认额度</span>
              <label className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-stone-500">
                用户
                <Input
                  className="h-8 w-20 rounded-xl border-stone-200 bg-white text-sm xl:w-24"
                  inputMode="numeric"
                  min={0}
                  type="number"
                  value={defaultQuotaDrafts.user_image_quota_limit}
                  disabled={isSavingDefaultQuotas}
                  onChange={(event) =>
                    setDefaultQuotaDrafts((current) => ({ ...current, user_image_quota_limit: event.target.value }))
                  }
                />
              </label>
              <label className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-stone-500">
                访客
                <Input
                  className="h-8 w-20 rounded-xl border-stone-200 bg-white text-sm xl:w-24"
                  inputMode="numeric"
                  min={0}
                  type="number"
                  value={defaultQuotaDrafts.guest_image_quota_limit}
                  disabled={isSavingDefaultQuotas}
                  onChange={(event) =>
                    setDefaultQuotaDrafts((current) => ({ ...current, guest_image_quota_limit: event.target.value }))
                  }
                />
              </label>
              <Button
                variant="outline"
                size="sm"
                className="h-8 whitespace-nowrap rounded-xl border-stone-200 bg-white px-3"
                disabled={isSavingDefaultQuotas}
                onClick={() => void saveDefaultQuotas()}
              >
                {isSavingDefaultQuotas ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存默认
              </Button>
              <span className="hidden whitespace-nowrap text-xs text-stone-400 xl:inline">仅影响未单独设置额度的用户</span>
            </div>
            <Button
              variant="outline"
              className="h-9 rounded-xl border-stone-200 bg-white px-3"
              onClick={() => void loadUsers()}
              disabled={isLoading}
            >
              {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              刷新
            </Button>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-stone-200/80 bg-white px-3 py-2 shadow-sm md:hidden">
          <span className="whitespace-nowrap text-sm font-semibold text-stone-800">默认额度</span>
          <label className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-stone-500">
            用户
            <Input
              className="h-8 w-24 rounded-xl border-stone-200 bg-white text-sm"
              inputMode="numeric"
              min={0}
              type="number"
              value={defaultQuotaDrafts.user_image_quota_limit}
              disabled={isSavingDefaultQuotas}
              onChange={(event) =>
                setDefaultQuotaDrafts((current) => ({ ...current, user_image_quota_limit: event.target.value }))
              }
            />
          </label>
          <label className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-stone-500">
            访客
            <Input
              className="h-8 w-24 rounded-xl border-stone-200 bg-white text-sm"
              inputMode="numeric"
              min={0}
              type="number"
              value={defaultQuotaDrafts.guest_image_quota_limit}
              disabled={isSavingDefaultQuotas}
              onChange={(event) =>
                setDefaultQuotaDrafts((current) => ({ ...current, guest_image_quota_limit: event.target.value }))
              }
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            className="h-8 whitespace-nowrap rounded-xl border-stone-200 bg-white px-3"
            disabled={isSavingDefaultQuotas}
            onClick={() => void saveDefaultQuotas()}
          >
            {isSavingDefaultQuotas ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存默认
          </Button>
          <span className="whitespace-nowrap text-xs text-stone-400">仅影响未单独设置额度的用户</span>
        </div>

        <div className="hidden shrink-0 gap-3 sm:grid-cols-4">
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
            <div className="shrink-0 border-b border-stone-100 bg-white p-2 sm:p-3">
              <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                <div className="relative w-full xl:max-w-[380px]">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
                  <Input
                    className="h-9 rounded-xl border-stone-200 bg-white pl-10 pr-10 text-sm"
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
                <div className="flex flex-wrap items-center gap-1.5">
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
                        "h-8 rounded-xl border px-3 text-sm font-medium transition",
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
                        "h-8 rounded-xl border px-3 text-sm font-medium transition",
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
                      className="h-8 rounded-xl px-3 text-stone-600"
                      onClick={resetFilters}
                    >
                      <X className="size-4" />
                      重置
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 text-xs font-medium text-stone-500">
                显示 {filteredUsers.length} / {users.length} 个用户
              </div>
              <div className={cn("mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-stone-100 bg-stone-50/80 p-1.5", !hasSelectedUsers && "hidden")}>
                <span className="px-2 text-xs font-semibold text-stone-500">已选 {selectedUsers.length} 个</span>
                <Input
                  className="h-8 w-28 rounded-xl border-stone-200 bg-white text-sm"
                  inputMode="numeric"
                  min={0}
                  type="number"
                  value={bulkQuotaDraft}
                  placeholder="批量额度"
                  disabled={!hasSelectedUsers || isBulkBusy}
                  onChange={(event) => setBulkQuotaDraft(event.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-xl border-stone-200 bg-white px-3"
                  disabled={!hasSelectedUsers || isBulkBusy}
                  onClick={() => void saveBulkFiniteQuota()}
                >
                  {isBulkSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                  批量保存
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-stone-600"
                  disabled={!hasSelectedUsers || isBulkBusy}
                  onClick={() => void saveBulkQuota(-1)}
                >
                  <Infinity className="size-4" />
                  批量无限
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-red-600 hover:bg-red-50 hover:text-red-700"
                  disabled={!hasSelectedUsers || isBulkBusy}
                  onClick={() => void deleteSelectedUsers()}
                >
                  {isBulkDeleting ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  批量删除
                </Button>
                {hasSelectedUsers ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 rounded-xl px-3 text-stone-600"
                    disabled={isBulkBusy}
                    onClick={clearSelectedUsers}
                  >
                    <X className="size-4" />
                    清空选择
                  </Button>
                ) : null}
              </div>
            </div>
            {isLoading ? (
              <div className="flex h-40 items-center justify-center">
                <LoaderCircle className="size-5 animate-spin text-stone-400" />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[1380px] border-collapse text-left text-sm md:text-center">
                  <thead className="sticky top-0 z-10 border-b border-stone-100 bg-stone-50 text-xs font-semibold text-stone-500">
                    <tr>
                      <th className="w-12 whitespace-nowrap px-5 py-3 md:text-center">
                        <input
                          type="checkbox"
                          className="size-4 rounded border-stone-300 accent-stone-950"
                          checked={allVisibleSelected}
                          disabled={selectableFilteredUsers.length === 0 || isBulkBusy}
                          onChange={toggleVisibleSelected}
                          aria-label="全选当前筛选用户"
                        />
                      </th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">用户</th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">角色</th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">会话</th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">可用额度</th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-1 py-0.5 transition hover:bg-stone-100 hover:text-stone-950"
                          onClick={toggleUsedSort}
                          aria-label="按使用额度排序"
                        >
                          使用额度
                          <span className="text-[10px] text-stone-400">
                            {usedSort === "desc" ? "↓" : usedSort === "asc" ? "↑" : "↕"}
                          </span>
                        </button>
                      </th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">图片额度</th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">最后登录</th>
                      <th className="whitespace-nowrap px-5 py-3 md:text-center">创建时间</th>
                      <th className="whitespace-nowrap px-5 py-3 text-right md:text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {displayedUsers.map((user) => (
                      <tr key={user.id} className={cn("align-top md:align-middle", selectedUserIds.includes(user.id) && "bg-stone-50")}>
                        <td className="px-5 py-4 md:text-center">
                          <input
                            type="checkbox"
                            className="size-4 rounded border-stone-300 accent-stone-950"
                            checked={selectedUserIds.includes(user.id)}
                            disabled={user.role === "admin" || isBulkBusy}
                            onChange={() => toggleUserSelected(user)}
                            aria-label={`选择 ${user.username || user.name}`}
                          />
                        </td>
                        <td className="px-5 py-4 md:text-center">
                          <div className="flex items-center gap-2 md:justify-center">
                            <div className="inline-flex size-8 items-center justify-center rounded-full bg-stone-100 text-stone-500">
                              {user.role === "admin" ? <ShieldCheck className="size-4" /> : <UserRound className="size-4" />}
                            </div>
                            <div className="min-w-0">
                              <div className="whitespace-nowrap font-semibold text-stone-950">{user.username || user.name}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4 md:text-center">
                          <span
                            className={cn(
                              "inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold",
                              user.role === "admin" ? "bg-stone-950 text-white" : "bg-stone-100 text-stone-600",
                            )}
                          >
                            {roleLabel(user.role)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-stone-600 md:text-center">
                          {formatSession(user)}
                        </td>
                        <td className="px-5 py-4 md:text-center">
                          <div className="whitespace-nowrap font-semibold text-stone-950">
                            {formatUserQuota(user)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 font-semibold text-stone-950 md:text-center">
                          {Math.max(0, user.used_total)}
                        </td>
                        <td className="px-5 py-4 md:text-center">
                          {user.role === "admin" ? (
                            <span className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full bg-stone-100 px-3 text-xs font-semibold text-stone-600">
                              <Infinity className="size-4" />
                              无限
                            </span>
                          ) : (
                            <div className="flex min-w-[250px] items-center gap-2 whitespace-nowrap md:justify-center">
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
                        <td className="whitespace-nowrap px-5 py-4 text-stone-600 md:text-center">{formatTime(user.last_used_at)}</td>
                        <td className="whitespace-nowrap px-5 py-4 text-stone-600 md:text-center">{formatTime(user.created_at)}</td>
                        <td className="whitespace-nowrap px-5 py-4 text-right md:text-center">
                          {user.role === "admin" ? (
                            <span className="text-xs font-medium text-stone-300">--</span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9 whitespace-nowrap rounded-xl px-3 text-red-600 hover:bg-red-50 hover:text-red-700"
                              disabled={Boolean(deletingUserIds[user.id]) || isBulkBusy}
                              onClick={() => void deleteUser(user)}
                              aria-label={`删除 ${user.username || user.name || user.id}`}
                            >
                              {deletingUserIds[user.id] ? (
                                <LoaderCircle className="size-4 animate-spin" />
                              ) : (
                                <Trash2 className="size-4" />
                              )}
                              删除
                            </Button>
                          )}
                        </td>
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
