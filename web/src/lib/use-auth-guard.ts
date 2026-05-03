"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { login } from "@/lib/api";
import {
  getDefaultRouteForRole,
  getStoredAuthSession,
  setStoredAuthSession,
  type AuthRole,
  type StoredAuthSession,
} from "@/store/auth";

type UseAuthGuardResult = {
  isCheckingAuth: boolean;
  session: StoredAuthSession | null;
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
      const storedSession = await getStoredAuthSession();
      if (!active) {
        return;
      }

      let session = storedSession;
      if (!session) {
        try {
          const data = await login("");
          session = {
            key: "",
            role: data.role,
            subjectId: data.subject_id,
            name: data.name,
          };
          await setStoredAuthSession(session);
        } catch {
          session = null;
        }
      }
      if (!active) {
        return;
      }

      if (!session) {
        setSession(null);
        setIsCheckingAuth(false);
        return;
      }

      if (roleList.length > 0 && !roleList.includes(session.role)) {
        setSession(session);
        setIsCheckingAuth(false);
        router.replace(getDefaultRouteForRole(session.role));
        return;
      }

      setSession(session);
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
  const router = useRouter();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const storedSession = await getStoredAuthSession();
      if (!active) {
        return;
      }

      if (storedSession) {
        router.replace(getDefaultRouteForRole(storedSession.role));
        return;
      }

      setIsCheckingAuth(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, [router]);

  return { isCheckingAuth };
}
