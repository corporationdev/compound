import { useAuth } from "@/context/auth";
export function useAvatar() { const auth = useAuth(); return () => auth.user()?.image ?? null; }
