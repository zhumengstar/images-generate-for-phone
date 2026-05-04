"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { login } from "@/lib/api";
import {
  getDefaultRouteForRole,
  getSyncStoredAuthSession,
  getStoredAuthSession,
  type AuthRole,
  type StoredAuthSession,
} from "@/store/auth";

type UseAuthGuardResult = {
  isCheckingAuth: boolean;
  session: StoredAuthSession | null;
};

const guestSession: StoredAuthSession = {
  key: "",
  role: "user",
  subjectId: "guest",
  name: "访客",
  isGuest: true,
};

export function useAuthGuard(allowedRoles?: AuthRole[]): UseAuthGuardResult {
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const allowedRolesKey = (allowedRoles || []).join(",");

  useEffect(() => {
    let active = true;

    const load = async () => {
      const roleList = allowedRolesKey ? (allowedRolesKey.split(",") as AuthRole[]) : [];
      const syncSession = getSyncStoredAuthSession();
      if (syncSession) {
        setSession(syncSession);
        setIsCheckingAuth(false);
      }
      const storedSession = syncSession || (await getStoredAuthSession());
      if (!active) {
        return;
      }

      let nextSession = storedSession;
      if (!nextSession) {
        try {
          const data = await login("");
          nextSession = {
            ...guestSession,
            role: data.role,
            subjectId: data.subject_id,
            name: data.name || "访客",
          };
        } catch {
          nextSession = roleList.length === 0 ? guestSession : null;
        }
      }
      if (!active) {
        return;
      }

      if (!nextSession) {
        setSession(null);
        setIsCheckingAuth(false);
        return;
      }

      if (roleList.length > 0 && !roleList.includes(nextSession.role)) {
        setSession(nextSession);
        setIsCheckingAuth(false);
        router.replace(getDefaultRouteForRole(nextSession.role));
        return;
      }

      setSession(nextSession);
      setIsCheckingAuth(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, [allowedRolesKey, router]);

  return { isCheckingAuth, session };
}

export function useRedirectIfAuthenticated() {
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!active) {
        return;
      }
      setIsCheckingAuth(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  return { isCheckingAuth };
}
