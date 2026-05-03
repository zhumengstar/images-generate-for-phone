"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    const redirect = () => {
      if (!active) {
        return;
      }
      router.replace("/image");
    };

    redirect();
    return () => {
      active = false;
    };
  }, [router]);

  return null;
}
